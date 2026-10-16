package org.metadatacenter.cedar.resource.version;

import org.junit.jupiter.api.*;
import org.metadatacenter.model.folderserver.basic.FolderServerSchemaArtifact;
import org.metadatacenter.server.neo4j.VersionChainTransaction;
import org.metadatacenter.server.search.elasticsearch.service.NodeIndexingService;
import org.neo4j.driver.*;
import org.neo4j.harness.*;

import java.util.*;
import java.util.stream.IntStream;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Opt-in experiment, deliberately outside Surefire's default *Test naming convention.
 * Run with -Dtest=VersionProjectionHistoryExperiment -Dcedar.fuzz.runs=100.
 * Replay one history with -Dcedar.fuzz.seed=<reported seed> -Dcedar.fuzz.runs=1.
 *
 * The oracle is three ordered lists, not a second graph traversal. The real transaction helper
 * and projection worker use embedded Neo4j. Only external document/inclusion/index/notification
 * writes are simulated. Their partial effects survive transaction rollback and worker restart.
 * This probes sequential histories, not concurrent scheduling, HTTP authorization or real stores.
 */
class VersionProjectionHistoryExperiment {
  private static Neo4j neo;
  private static Driver observer;
  private static final Map<String, Integer> coverage = new TreeMap<>();

  @BeforeAll static void start() {
    neo = Neo4jBuilders.newInProcessBuilder().withDisabledServer().build();
    observer = GraphDatabase.driver(neo.boltURI(), AuthTokens.none());
    VersionChainTransaction.initialize(observer);
  }

  @AfterAll static void stop() {
    System.out.println("VERSION HISTORY COVERAGE " + coverage);
    observer.close();
    neo.close();
  }

  @TestFactory Stream<DynamicTest> histories() {
    long first = Long.getLong("cedar.fuzz.seed", 731_000L);
    return IntStream.range(0, Integer.getInteger("cedar.fuzz.runs", 20))
        .mapToObj(n -> DynamicTest.dynamicTest("version history seed=" + (first + n), () -> {
          try (var history = new History(first + n)) {
            history.run(Integer.getInteger("cedar.fuzz.steps", 60));
          }
        }));
  }

  private record Entry(String id, int version, boolean draft, String name) {}
  private record Job(boolean link, String content) {}
  private record View(String id, String previous, String version, String status, String name,
                      boolean latest, boolean draft, boolean published) {}

  private static void count(String key) { coverage.merge(key, 1, Integer::sum); }

  private static final class History implements AutoCloseable {
    final long seed;
    final Random random;
    final List<List<Entry>> chains = List.of(new ArrayList<>(), new ArrayList<>(), new ArrayList<>());
    final Map<String, Job> jobs = new TreeMap<>();
    final Map<String, String> documentLinks = new HashMap<>();
    final Map<String, String> inclusions = new HashMap<>(), notifications = new HashMap<>();
    final Map<String, View> indexed = new HashMap<>();
    final List<String> trace = new ArrayList<>(), boundaryErrors = new ArrayList<>();
    final NodeIndexingService index = mock(NodeIndexingService.class);
    VersionProjectionService worker;
    String failedSurface = "";
    boolean lostReply;
    int serial;

    History(long seed) throws Exception {
      this.seed = seed;
      random = new Random(seed);
      try (var s = observer.session()) {
        s.run("MATCH (n) WHERE NOT n:CedarVersionLock DETACH DELETE n").consume();
      }
      when(index.indexDocumentForProjection(any(), isNull())).thenAnswer(call -> {
        var a = (FolderServerSchemaArtifact) call.getArgument(0);
        var view = new View(a.getId(), a.getPreviousVersion() == null ? null : a.getPreviousVersion().getId(),
            a.getVersion().getValue(), a.getPublicationStatus().getValue(), a.getName(),
            a.isLatestVersion(), a.isLatestDraftVersion(), a.isLatestPublishedVersion());
        checkBoundary(Objects.equals(views().get(a.getId()), view), "stale index " + view);
        external("index", () -> indexed.put(a.getId(), view));
        return null;
      });
      restart();
    }

    void restart() {
      if (worker != null) worker.close();
      worker = new VersionProjectionService(GraphDatabase.driver(neo.boltURI(), AuthTokens.none()), index,
          (a, previous) -> {
            checkBoundary(views().containsKey(a.getId()) && Objects.equals(views().get(a.getId()).previous(), previous),
                "stale document link " + a.getId());
            external("link", () -> documentLinks.put(a.getId(), previous));
          }, (a, body, context) -> {
            String content = body.path("name").asText();
            checkBoundary(jobs.containsKey(a.getId()) && Objects.equals(jobs.get(a.getId()).content(), content),
                "stale content " + a.getId());
            external("content", () -> inclusions.put(a.getId(), content));
          }, a -> {
            checkBoundary(views().containsKey(a.getId()) && Objects.equals(views().get(a.getId()).name(), a.getName()),
                "stale notification " + a.getId());
            external("notification", () -> notifications.put(a.getId(), a.getName()));
          });
      count("restart");
    }

    void checkBoundary(boolean condition, String message) {
      // Record outside the worker's exception handling; a swallowed callback error must still fail.
      if (!condition) boundaryErrors.add(message);
    }

    void external(String surface, Runnable write) {
      boolean fail = failedSurface.equals(surface);
      if (fail && !lostReply) throw new IllegalStateException("injected " + surface + " unavailable");
      write.run();
      if (fail) throw new IllegalStateException("injected " + surface + " reply lost after write");
    }

    Map<String, View> views() {
      var result = new TreeMap<String, View>();
      for (var chain : chains) {
        // Valid histories have increasing versions; deleting preserves that order.
        int release = chain.size() - 1;
        if (release >= 0 && chain.get(release).draft()) release--;
        for (int i = 0; i < chain.size(); i++) {
          var e = chain.get(i);
          result.put(e.id(), new View(e.id(), i == 0 ? null : chain.get(i - 1).id(), e.version() + ".0.0",
              e.draft() ? "bibo:draft" : "bibo:published", e.name(), i == chain.size() - 1, e.draft(), i == release));
        }
      }
      return result;
    }

    void queue(String id, boolean link, String content) {
      var old = jobs.get(id);
      jobs.put(id, new Job(link || old != null && old.link(), content != null ? content : old == null ? null : old.content()));
    }

    void queueChain(List<Entry> chain) { chain.forEach(e -> queue(e.id(), false, null)); }

    void advance(List<Entry> chain) {
      var tail = chain.isEmpty() ? null : chain.get(chain.size() - 1);
      boolean publish = tail != null && tail.draft();
      String id = publish ? tail.id() : "https://repo.metadatacenter.org/templates/" + new UUID(seed, ++serial);
      int version = tail == null ? 1 : publish ? tail.version() : tail.version() + 1 + random.nextInt(10);
      String name = publish ? tail.name() : "entry-" + serial;
      trace.add((publish ? "publish " : "draft ") + id + " " + version);
      try (var s = observer.session()) {
        s.writeTransaction(tx -> {
          VersionChainTransaction.lock(tx);
          if (publish) {
            assertTrue(VersionChainTransaction.requirePublish(tx, id, version + ".0.0"));
            tx.run("MATCH (a:Artifact {_id:$id}) SET a.bibo_status='bibo:published'", Map.of("id", id)).consume();
          } else {
            if (tail != null) VersionChainTransaction.requireDraftSource(tx, tail.id(), version + ".0.0");
            tx.run("CREATE (:Artifact:Template {_id:$id, resourceType:'template', schema_name:$name, "
                + "pav_version:$version, bibo_status:'bibo:draft'})",
                Map.of("id", id, "name", name, "version", version + ".0.0")).consume();
            if (tail != null) tx.run("MATCH (a:Artifact {_id:$id}), (p:Artifact {_id:$previous}) "
                + "SET a.pav_previousVersion=$previous CREATE (a)-[:PREVIOUSVERSION]->(p)",
                Map.of("id", id, "previous", tail.id())).consume();
            VersionChainTransaction.enqueueContent(tx, id, "{\"name\":\"" + name + "\"}");
          }
          VersionChainTransaction.reconcile(tx, id);
          return null;
        });
      }
      if (publish) chain.set(chain.size() - 1, new Entry(id, version, false, name));
      else {
        chain.add(new Entry(id, version, true, name));
        documentLinks.put(id, tail == null ? null : tail.id());
        queue(id, false, name);
      }
      queueChain(chain);
      count(publish ? "publish" : "draft");
    }

    void delete(List<Entry> chain, boolean rollback) {
      if (chain.isEmpty()) { advance(chain); return; }
      int position = random.nextInt(chain.size());
      var e = chain.get(position);
      trace.add("delete " + e.id() + " rollback=" + rollback);
      try (var s = observer.session(); var tx = s.beginTransaction()) {
        VersionChainTransaction.delete(tx, e.id());
        if (rollback) tx.rollback(); else tx.commit();
      }
      if (!rollback) {
        if (position + 1 < chain.size()) queue(chain.get(position + 1).id(), true, null);
        chain.remove(position);
        jobs.remove(e.id());
        // External deletion belongs to the separate deletion outbox, outside this experiment.
        documentLinks.remove(e.id()); indexed.remove(e.id());
        inclusions.remove(e.id()); notifications.remove(e.id());
        queueChain(chain);
      }
      count(rollback ? "delete rollback" : "delete " + (position == 0 ? "root" : position == chain.size() ? "tail" : "middle"));
    }

    void edit(List<Entry> chain, boolean rollback) {
      if (chain.isEmpty() || !chain.get(chain.size() - 1).draft()) { advance(chain); return; }
      var e = chain.get(chain.size() - 1);
      String name = "edited-" + (++serial);
      trace.add("edit " + e.id() + " " + name + " rollback=" + rollback);
      try (var s = observer.session(); var tx = s.beginTransaction()) {
        VersionChainTransaction.lock(tx);
        tx.run("MATCH (a:Artifact {_id:$id}) SET a.schema_name=$name", Map.of("id", e.id(), "name", name)).consume();
        VersionChainTransaction.enqueueContent(tx, e.id(), "{\"name\":\"" + name + "\"}");
        if (rollback) tx.rollback(); else tx.commit();
      }
      if (!rollback) {
        chain.set(chain.size() - 1, new Entry(e.id(), e.version(), true, name));
        queue(e.id(), false, name);
      }
      count(rollback ? "edit rollback" : "edit");
    }

    void complete(String id, String failure, boolean afterWrite) {
      failedSurface = failure;
      lostReply = afterWrite;
      trace.add("complete " + id + " fail=" + failure + " afterWrite=" + afterWrite);
      Job job = jobs.get(id);
      boolean fails = job != null && switch (failure) {
        case "link" -> job.link();
        case "content", "notification" -> job.content() != null;
        case "index" -> true;
        default -> false;
      };
      assertEquals(!fails, worker.complete(id, index, null), "completion result");
      if (!fails) jobs.remove(id);
      else count("failure " + failure + (afterWrite ? " after write" : " before write"));
      failedSurface = "";
      count("complete");
    }

    void drain() {
      failedSurface = "";
      trace.add("drain");
      int batches = (jobs.size() + 24) / 25;
      for (int i = 0; i < batches; i++) worker.completePending(index, null);
      jobs.clear();
      count(batches > 1 ? "multi-batch drain" : "drain");
    }

    void verify() {
      assertEquals(List.of(), boundaryErrors, "external writes must reflect current committed state");
      var expected = views();
      try (var s = observer.session()) {
        var actual = new TreeMap<String, View>();
        var rows = s.run("MATCH (a:Artifact) OPTIONAL MATCH (a)-[:PREVIOUSVERSION]->(p) "
            + "RETURN properties(a) AS a, collect(p._id) AS predecessors").list();
        for (var r : rows) {
          var a = r.get("a");
          String id = a.get("_id").asString();
          String previous = a.get("pav_previousVersion").asString(null);
          assertEquals(previous == null ? List.of() : List.of(previous), r.get("predecessors").asList(), "history edge " + id);
          actual.put(id, new View(id, previous, a.get("pav_version").asString(), a.get("bibo_status").asString(),
              a.get("schema_name").asString(), a.get("isLatestVersion").asBoolean(),
              a.get("isLatestDraftVersion").asBoolean(), a.get("isLatestPublishedVersion").asBoolean()));
        }
        assertEquals(expected, actual, "surviving chains and latest flags");
        var pending = new TreeMap<String, Job>();
        for (var r : s.run("MATCH (j:CedarVersionProjection) RETURN properties(j) AS j").list()) {
          var j = r.get("j");
          String content = j.get("content").isNull() ? null :
              org.metadatacenter.util.json.JsonMapper.STRICT_MAPPER.readTree(j.get("content").asString()).path("name").asText();
          pending.put(j.get("resourceId").asString(), new Job(j.get("syncPrevious").asBoolean(), content));
        }
        assertEquals(jobs, pending, "durable intent, including coalesced link and content work");
      } catch (java.io.IOException ex) { throw new AssertionError(ex); }
      for (var v : expected.values()) {
        if (jobs.containsKey(v.id())) continue; // Intermediate divergence is allowed only with durable retry intent.
        assertEquals(v, indexed.get(v.id()), "acknowledged index " + v.id());
        assertEquals(v.previous(), documentLinks.get(v.id()), "acknowledged predecessor " + v.id());
        assertEquals(v.name(), inclusions.get(v.id()), "acknowledged content " + v.id());
        assertEquals(v.name(), notifications.get(v.id()), "acknowledged notification " + v.id());
      }
    }

    void run(int steps) {
      try {
        for (var chain : chains) {
          int versions = 3 + random.nextInt(10);
          for (int n = 0; n < versions; n++) { advance(chain); advance(chain); }
          advance(chain);
        }
        verify();
        for (int n = 0; n < steps; n++) {
          var chain = chains.get(random.nextInt(chains.size()));
          switch (random.nextInt(10)) {
            case 0, 1 -> advance(chain);
            case 2, 3 -> delete(chain, false);
            case 4 -> delete(chain, true);
            case 5 -> edit(chain, random.nextBoolean());
            case 6, 7 -> {
              if (jobs.isEmpty()) advance(chain);
              else {
                String id = new ArrayList<>(jobs.keySet()).get(random.nextInt(jobs.size()));
                complete(id, List.of("", "link", "content", "index", "notification").get(random.nextInt(5)), random.nextBoolean());
              }
            }
            case 8 -> { trace.add("restart"); restart(); }
            case 9 -> drain();
          }
          verify();
        }
        drain(); verify();
        // A callback retained by an older request after all work settled must be inert.
        var before = new HashMap<>(indexed);
        for (String id : views().keySet()) complete(id, "index", false);
        assertEquals(before, indexed);
        verify();
      } catch (Throwable failure) {
        throw new AssertionError("seed=" + seed + " shortest checked failing prefix:\n" + String.join("\n", trace), failure);
      }
    }

    @Override public void close() { if (worker != null) worker.close(); }
  }
}
