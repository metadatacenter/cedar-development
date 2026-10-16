package org.metadatacenter.server.search.util;

import org.junit.jupiter.api.*;
import redis.clients.jedis.*;
import java.net.ServerSocket;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Opt-in Redis probe: uses an isolated native Redis and schedules interleavings at real command boundaries. */
class RebuildHistoryExperiment {
  static Process redis;
  static int port;
  static JedisPool pool;
  static Path directory;

  @BeforeAll static void start() throws Exception {
    directory=Files.createTempDirectory("cedar-rebuild-probe-");
    try(var socket=new ServerSocket(0)) { port=socket.getLocalPort(); }
    redis=new ProcessBuilder("redis-server","--bind","127.0.0.1","--port",String.valueOf(port),
        "--save","","--appendonly","no","--dir",directory.toString())
        .redirectErrorStream(true).redirectOutput(directory.resolve("redis.log").toFile()).start();
    pool=new JedisPool("127.0.0.1",port);
    long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);
    while(System.nanoTime()<deadline) {
      try(var j=pool.getResource()) { if("PONG".equals(j.ping())) return; }
      catch(Exception ignored) { Thread.sleep(20); }
    }
    redis.destroyForcibly(); fail("isolated Redis did not start: "+directory);
  }
  @AfterAll static void stop() throws Exception {
    if(pool!=null) pool.close();
    if(redis!=null) { redis.destroy(); if(!redis.waitFor(5,TimeUnit.SECONDS)) redis.destroyForcibly().waitFor(); }
  }
  void clear() { try(var j=pool.getResource()) { j.flushDB(); } }

  @TestFactory Stream<DynamicTest> sequentialHistories() {
    long first=Long.getLong("cedar.fuzz.seed",840000L);
    return IntStream.range(0,Integer.getInteger("cedar.fuzz.runs",50)).mapToObj(n ->
        DynamicTest.dynamicTest("rebuild history "+(first+n),()->run(first+n)));
  }
  void run(long seed) {
    clear(); var store=new RedisIndexRebuildStore(pool); var random=new Random(seed);
    var written=new HashSet<String>(); var deleted=new HashSet<String>();
    String current=null; var trace=new ArrayList<String>();
    try {
      for(int step=0;step<200;step++) {
        String id="resource-"+random.nextInt(10), name="index-"+random.nextInt(3);
        switch(random.nextInt(4)) {
          case 0 -> { trace.add("begin "+name); store.begin(name); current=name; written.clear(); deleted.clear(); }
          case 1 -> {
            trace.add("end "+name); store.end(name);
            if(name.equals(current)) { current=null; written.clear(); deleted.clear(); }
          }
          case 2 -> {
            trace.add("write "+id); store.recordWrite(id);
            if(current!=null) { written.add(id); deleted.remove(id); }
          }
          case 3 -> {
            trace.add("delete "+id); store.recordDelete(id);
            if(current!=null) { deleted.add(id); written.remove(id); }
          }
        }
        assertEquals(Optional.ofNullable(current),store.inProgressIndex());
        assertEquals(written,store.written()); assertEquals(deleted,store.deleted());
        assertFalse(store.overflowed());
      }
    } catch(Throwable failure) { throw new AssertionError("seed="+seed+"\n"+String.join("\n",trace),failure); }
  }

}
