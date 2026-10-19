package org.metadatacenter.cedar.artifact.resources;

import com.fasterxml.jackson.databind.JsonNode;
import com.mongodb.client.*;
import com.mongodb.client.model.*;
import org.bson.Document;
import org.junit.jupiter.api.*;
import org.metadatacenter.config.environment.CedarEnvironmentSource;
import org.metadatacenter.exception.ArtifactServerResourceNotFoundException;
import org.metadatacenter.server.dao.ArtifactRevisionConflictException;
import org.metadatacenter.server.dao.ArtifactWithRevision;
import org.metadatacenter.server.dao.mongodb.GenericLDDaoMongoDB;
import org.metadatacenter.util.json.JsonMapper;
import org.metadatacenter.util.test.EmbeddedCedarMongo;

import java.util.*;
import java.util.stream.*;
import static org.junit.jupiter.api.Assertions.*;

/** Opt-in storage-level history probe; no running CEDAR service is contacted. */
class RevisionHistoryExperiment {
  static MongoClient client;
  static final String DB="revision-history-experiment", COLLECTION="artifacts";
  static final List<String> IDS=List.of("a","b","c","d");

  @BeforeAll static void start() {
    EmbeddedCedarMongo.startAndRedirectEnvironment();
    client=MongoClients.create("mongodb://" + CedarEnvironmentSource.get("CEDAR_MONGO_HOST") + ":"
        + CedarEnvironmentSource.get("CEDAR_MONGO_PORT"));
  }
  @AfterAll static void stop() { client.getDatabase(DB).drop(); client.close(); }

  @TestFactory Stream<DynamicTest> histories() {
    long first=Long.getLong("cedar.fuzz.seed",830000L);
    return IntStream.range(0,Integer.getInteger("cedar.fuzz.runs",20)).boxed().flatMap(i ->
        Stream.of(false,true).map(bulk -> DynamicTest.dynamicTest("seed="+(first+i)+" bulk="+bulk,
            () -> run(first+i,bulk))));
  }

  @Test void bulkDeleteMustPreserveTheUniqueIdentifierConstraint() throws Exception {
    client.getDatabase(DB).drop();
    var collection=client.getDatabase(DB).getCollection(COLLECTION);
    collection.createIndex(Indexes.ascending("@id"),new IndexOptions().unique(true));
    var dao=new GenericLDDaoMongoDB(client,DB,COLLECTION);
    dao.create(body("same-id","first incarnation"));
    dao.deleteAll();
    dao.create(body("same-id","second incarnation"));
    assertThrows(ArtifactRevisionConflictException.class,()->dao.create(body("same-id","duplicate")),
        "clearing artifacts must not remove the uniqueness constraint for subsequent writes");
  }

  void run(long seed,boolean bulk) throws Exception {
    client.getDatabase(DB).drop();
    var collection=client.getDatabase(DB).getCollection(COLLECTION);
    collection.createIndex(Indexes.ascending("@id"),new IndexOptions().unique(true));
    var dao=new GenericLDDaoMongoDB(client,DB,COLLECTION);
    var model=new HashMap<String,ArtifactWithRevision<JsonNode>>();
    var receipts=new HashMap<String,List<Long>>();
    for(String id:IDS) receipts.put(id,new ArrayList<>());
    // Legacy documents start at revision zero; subsequent incarnations must never reuse it.
    collection.insertOne(new Document("@id","a").append("schema:name","legacy"));
    model.put("a",new ArtifactWithRevision<>(body("a","legacy"),0)); receipts.get("a").add(0L);
    var random=new Random(seed); var trace=new ArrayList<String>();
    try {
      for(int step=0;step<Integer.getInteger("cedar.fuzz.steps",100);step++) {
        String id=IDS.get(random.nextInt(IDS.size()));
        var old=model.get(id);
        var body=body(id,"value-"+step);
        int command=random.nextInt(bulk?7:6);
        if(command==0) {
          trace.add("create "+id);
          if(old!=null) {
            var target=dao;
            assertThrows(ArtifactRevisionConflictException.class,()->target.createWithRevision(body));
          } else {
            var created=normalized(dao.createWithRevision(body));
            assertEquals(body,created.content());
            for(long prior:receipts.get(id)) assertTrue(created.revision()>prior,"recreated revision must exceed every old validator");
            model.put(id,created); receipts.get(id).add(created.revision());
          }
        } else if(command==1 || command==2) {
          long revision=old==null?0:old.revision();
          if(!receipts.get(id).isEmpty() && random.nextBoolean())
            revision=receipts.get(id).get(random.nextInt(receipts.get(id).size()));
          long expected=revision; var target=dao;
          trace.add((command==1?"update ":"delete ")+id+" revision="+revision);
          org.junit.jupiter.api.function.Executable write=command==1?
              ()->target.update(id,body,expected):()->target.delete(id,expected);
          if(old==null) assertThrows(ArtifactServerResourceNotFoundException.class,write);
          else if(revision!=old.revision()) assertThrows(ArtifactRevisionConflictException.class,write);
          else if(command==1) {
            assertEquals(body,normalized(dao.update(id,body,revision)));
            assertFalse(receipts.get(id).contains(revision+1),"successful update must not reuse a prior validator");
            model.put(id,new ArtifactWithRevision<>(body,revision+1)); receipts.get(id).add(revision+1);
          } else { dao.delete(id,revision); model.remove(id); }
        } else if(command==3) {
          trace.add("read "+id);
          assertEquals(old,normalized(dao.findWithRevision(id)));
        } else if(command==4) {
          trace.add("restart DAO"); dao=new GenericLDDaoMongoDB(client,DB,COLLECTION);
        } else if(command==5) {
          trace.add("list"); assertEquals(new HashSet<>(model.values().stream().map(ArtifactWithRevision::content).toList()),
              new HashSet<>(dao.findAll().stream().map(RevisionHistoryExperiment::normalized).toList()));
        } else {
          trace.add("bulk delete"); dao.deleteAll(); model.clear();
        }
        assertEquals(model.size(),dao.count(),"one stored document per identifier");
        for(String check:IDS) assertEquals(model.get(check),normalized(dao.findWithRevision(check)),"stored body and validator "+check);
      }
    } catch(Throwable failure) { throw new AssertionError("seed="+seed+" bulk="+bulk+"\n"+String.join("\n",trace),failure); }
  }

  // The DAO exposes Mongo's _id; the service layer strips it. Revision/content semantics are the subject here.
  static JsonNode normalized(JsonNode node) {
    var copy=(com.fasterxml.jackson.databind.node.ObjectNode)node.deepCopy(); copy.remove("_id"); return copy;
  }
  static ArtifactWithRevision<JsonNode> normalized(ArtifactWithRevision<JsonNode> value) {
    return value==null?null:new ArtifactWithRevision<>(normalized(value.content()),value.revision());
  }

  static JsonNode body(String id,String value) {
    return JsonMapper.STRICT_MAPPER.createObjectNode().put("@id",id).put("schema:name",value);
  }
}
