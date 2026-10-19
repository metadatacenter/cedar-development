package org.metadatacenter.server.search.permission;

import org.junit.jupiter.api.*;
import org.metadatacenter.server.search.*;
import org.neo4j.driver.*;
import org.neo4j.harness.*;
import java.util.*;
import java.util.stream.*;
import static org.junit.jupiter.api.Assertions.*;

/** Opt-in histories of two relays retaining, replaying and acknowledging batches across restarts. */
class PermissionOutboxHistoryExperiment {
  static Neo4j neo;
  static Driver observer;
  @BeforeAll static void start() {
    neo=Neo4jBuilders.newInProcessBuilder().withDisabledServer().build();
    observer=GraphDatabase.driver(neo.boltURI(),AuthTokens.none());
  }
  @AfterAll static void stop() { observer.close(); neo.close(); }
  Neo4jSearchPermissionOutbox open() {
    return new Neo4jSearchPermissionOutbox(GraphDatabase.driver(neo.boltURI(),AuthTokens.none()));
  }
  record Event(String id,SearchPermissionQueueEventType type) {}

  @TestFactory Stream<DynamicTest> histories() {
    long first=Long.getLong("cedar.fuzz.seed",850000L);
    return IntStream.range(0,Integer.getInteger("cedar.fuzz.runs",30)).mapToObj(n ->
        DynamicTest.dynamicTest("outbox history "+(first+n),()->run(first+n)));
  }
  void run(long seed) {
    try(var s=observer.session()) { s.run("MATCH (n) DETACH DELETE n").consume(); }
    var random=new Random(seed); var trace=new ArrayList<String>();
    var expected=new LinkedHashMap<String,Event>();
    var snapshots=new ArrayList<List<String>>();
    var malformed=new HashSet<String>(); int quarantined=0;
    var relays=new Neo4jSearchPermissionOutbox[]{open(),open()};
    try {
      for(int step=0;step<Integer.getInteger("cedar.fuzz.steps",80);step++) {
        int which=random.nextInt(2); var relay=relays[which];
        switch(random.nextInt(8)) {
          case 0,1,2 -> {
            String resource="resource-"+random.nextInt(4);
            var types=SearchPermissionQueueEventType.values(); var type=types[random.nextInt(types.length)];
            String id=relay.append(new SearchPermissionQueueEvent(resource,type));
            trace.add("append "+step+" "+resource+" "+type);
            assertFalse(expected.containsKey(id)); expected.put(id,new Event(resource,type));
            // Give each event a deterministic order; real event IDs still come from the implementation.
            try(var s=observer.session()) {
              s.run("MATCH (j:CedarSearchPermissionOutbox {outboxId:$id}) SET j.createdAtTS=$time",
                  Map.of("id",id,"time",step)).consume();
            }
          }
          case 3 -> {
            int limit=1+random.nextInt(6); trace.add("relay "+which+" reads "+limit);
            var batch=relay.pending(limit);
            var ids=batch.stream().map(SearchPermissionOutbox.Entry::outboxId).toList();
            assertEquals(expected.keySet().stream().limit(limit).toList(),ids);
            snapshots.add(ids);
          }
          case 4 -> {
            if(!snapshots.isEmpty()) {
              int chosen=random.nextInt(snapshots.size()); trace.add("relay "+which+" acknowledges old batch "+chosen);
              var batch=snapshots.get(chosen); relay.remove(batch); batch.forEach(expected::remove);
            }
          }
          case 5 -> {
            trace.add("restart relay "+which); relay.close(); relays[which]=open();
          }
          case 6 -> {
            String id="malformed-"+step; trace.add("append malformed "+id); malformed.add(id);
            try(var s=observer.session()) {
              s.run("CREATE (:CedarSearchPermissionOutbox {outboxId:$id,resourceId:'resource-0',eventType:'UNKNOWN',createdAtTS:$time})",
                  Map.of("id",id,"time",step)).consume();
            }
          }
          case 7 -> {
            trace.add("quarantine"); relay.quarantineMalformed(); quarantined+=malformed.size(); malformed.clear();
          }
        }
        assertEquals(expected.size()+malformed.size(),relays[0].count());
        var observed=new LinkedHashMap<String,Event>();
        for(var e:relays[1].pending(1000)) observed.put(e.outboxId(),new Event(e.event().getId(),e.event().getEventType()));
        assertEquals(expected,observed,"no unacknowledged event may disappear or change");
        try(var s=observer.session()) {
          assertEquals(quarantined,s.run("MATCH (j:CedarSearchPermissionOutboxDeadLetter) RETURN count(j) AS n").single().get("n").asInt());
        }
      }
      for(var relay:relays) { relay.quarantineMalformed(); relay.remove(new ArrayList<>(expected.keySet())); }
      assertEquals(0,relays[0].count());
    } catch(Throwable failure) { throw new AssertionError("seed="+seed+"\n"+String.join("\n",trace),failure); }
    finally { for(var relay:relays) relay.close(); }
  }
}
