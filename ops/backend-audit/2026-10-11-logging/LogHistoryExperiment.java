package org.metadatacenter.cedar.monitor;

import io.dropwizard.hibernate.HibernateBundle;
import io.dropwizard.hibernate.UnitOfWorkAwareProxyFactory;
import io.dropwizard.testing.DropwizardTestSupport;
import org.hibernate.SessionFactory;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.metadatacenter.model.SystemComponent;
import org.metadatacenter.server.logging.AppLoggerExecutorService;
import org.metadatacenter.server.logging.agg.LogAggregationService;
import org.metadatacenter.server.logging.agg.RollupAccumulators;
import org.metadatacenter.server.logging.dao.ApplicationCypherLogDAO;
import org.metadatacenter.server.logging.dao.ApplicationRequestLogDAO;
import org.metadatacenter.server.logging.dao.agg.AggregationRollupDAO;
import org.metadatacenter.server.logging.dao.agg.LogAggregationStateDAO;
import org.metadatacenter.server.logging.model.*;

import java.lang.reflect.Field;
import java.sql.*;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.*;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Opt-in invariant probes: -Dtest=LogHistoryExperiment. Known failures are investigation evidence,
 * not accepted behavior. Uses the existing monitor database fixture and production UnitOfWork
 * proxies. No sleeps, external services, production data, or production pruning switches.
 */
class LogHistoryExperiment {
  private static final Instant AT = Instant.parse("2026-01-15T12:00:00Z");
  // A broad range avoids JDBC/JVM timezone differences; assertions concern totals, not hour labels.
  private static final Instant FROM = AT.minus(Duration.ofDays(1));
  private static final Instant TO = AT.plus(Duration.ofDays(1));
  private static HibernateBundle<?> bundle;
  private static SessionFactory sessions;
  private static AppLoggerExecutorService logger;
  private static String jdbcUrl;

  @BeforeAll static void start() throws Exception {
    LogListingPagingTest.oneTimeSetUp();
    DropwizardTestSupport<?> server = (DropwizardTestSupport<?>) field(LogListingPagingTest.class, "SERVER", null);
    bundle = (HibernateBundle<?>) field(MonitorServerApplication.class, "hibernate", server.getApplication());
    sessions = bundle.getSessionFactory();
    jdbcUrl = (String) field(LogListingPagingTest.class, "jdbcUrl", null);
    logger = new UnitOfWorkAwareProxyFactory(bundle).create(AppLoggerExecutorService.class,
        new Class[]{ApplicationRequestLogDAO.class, ApplicationCypherLogDAO.class},
        new Object[]{new ApplicationRequestLogDAO(sessions), new ApplicationCypherLogDAO(sessions)});
  }

  @AfterAll static void stop() { LogListingPagingTest.oneTimeTearDown(); }

  @BeforeEach void clear() throws Exception {
    new LogListingPagingTest().emptyTheLogTables();
    try (Connection c = connect(); Statement s = c.createStatement()) {
      s.executeUpdate("DELETE FROM agg_cypher_query_catalog");
    }
  }

  @Test void replayCommittedRequestStartMustSucceedAndPreserveCompletion() throws Exception {
    completeRequest();
    assertDoesNotThrow(() -> logger.handleLog(event(AppLogType.REQUEST_FILTER, AppLogSubType.START, 0)));
    assertEquals(1, scalar("SELECT COUNT(*) FROM log_request"));
    assertEquals(3_000_000_000L, scalar("SELECT handlerDuration FROM log_request"));
    assertEquals(503, scalar("SELECT status FROM log_request"));
  }

  @Test void replayCommittedCypherMustNotInflateUsage() throws Exception {
    AppLogMessage message = cypher();
    logger.handleLog(message);
    logger.handleLog(message); // same persisted message after a lost queue acknowledgement
    aggregate(service(new AggregationRollupDAO(sessions)), false);
    assertAll(
        () -> assertEquals(1, scalar("SELECT COUNT(*) FROM log_cypher")),
        () -> assertEquals(1, scalar("SELECT SUM(execCount) FROM agg_cypher_hourly")));
  }

  @ParameterizedTest(name = "arrival order {0}")
  @ValueSource(strings = {"SHE", "SEH", "HSE", "HES", "ESH", "EHS"})
  void requestArrivalOrderMustPreserveTimingAndStatus(String order) throws Exception {
    for (char stage : order.toCharArray()) logger.handleLog(requestStage(stage));
    assertAll(
        () -> assertEquals(1, scalar("SELECT COUNT(*) FROM log_request")),
        () -> assertEquals(503, scalar("SELECT COALESCE(status,0) FROM log_request")),
        () -> assertEquals(3_000_000_000L, scalar("SELECT handlerDuration FROM log_request")),
        () -> assertEquals(1_000_000_000L, scalar("SELECT preHandlerDuration FROM log_request")));
  }

  @Test void lateCompletionMustReachRollupsBeforePruning() throws Exception {
    logger.handleLog(requestStage('S'));
    logger.handleLog(requestStage('H'));
    LogAggregationService agg = service(new AggregationRollupDAO(sessions));
    aggregate(agg, true);
    logger.handleLog(requestStage('E'));
    aggregate(agg, true);
    assertEquals(3_000_000_000L, scalar("SELECT handlerDuration FROM log_request"), "raw completion arrived");
    long duration = scalar("SELECT SUM(sumHandlerNanos) FROM agg_request_hourly");
    long errors = scalar("SELECT SUM(errorCount) FROM agg_request_hourly");
    agg.pruneRequests(TO, 10);
    assertAll(
        () -> assertEquals(3_000_000_000L, duration, "completed duration must reach rollup"),
        () -> assertEquals(1, errors, "503 must reach error count"),
        () -> assertEquals(1, scalar("SELECT SUM(reqCount) FROM agg_request_hourly")),
        () -> assertEquals(0, scalar("SELECT COUNT(*) FROM log_request")));
  }

  @ParameterizedTest @ValueSource(booleans = {true, false})
  void overlappingAggregatorsMustCountOnce(boolean request) throws Exception {
    seed(request);
    CountDownLatch folded = new CountDownLatch(2);
    CountDownLatch release = new CountDownLatch(1);
    AggregationRollupDAO coordinated = new AggregationRollupDAO(sessions) {
      @Override public long[] foldLiveRequestBatch(RollupAccumulators acc, Instant from, Instant to, int limit) {
        long[] result = super.foldLiveRequestBatch(acc, from, to, limit);
        pause(); return result;
      }
      @Override public long[] foldLiveCypherBatch(RollupAccumulators acc, Instant from, Instant to, int limit) {
        long[] result = super.foldLiveCypherBatch(acc, from, to, limit);
        pause(); return result;
      }
      private void pause() { folded.countDown(); await(release); }
    };
    LogAggregationService agg = service(coordinated);
    ExecutorService workers = Executors.newFixedThreadPool(2);
    try {
      Future<Long> first = workers.submit(() -> aggregate(agg, request));
      Future<Long> second = workers.submit(() -> aggregate(agg, request));
      assertTrue(folded.await(10, TimeUnit.SECONDS), "both transactions must read before either flushes");
      release.countDown();
      first.get(15, TimeUnit.SECONDS);
      second.get(15, TimeUnit.SECONDS);
      assertEquals(1, scalar("SELECT SUM(" + countColumn(request) + ") FROM " + rollupTable(request)));
      assertEquals(1, scalar("SELECT COUNT(*) FROM " + rawTable(request) + " WHERE aggregatedAt IS NOT NULL"));
    } finally {
      release.countDown(); workers.shutdownNow();
      assertTrue(workers.awaitTermination(20, TimeUnit.SECONDS));
    }
  }

  @ParameterizedTest @ValueSource(booleans = {true, false})
  void delayedLowerIdCommitMustNotBeMarkedWithoutBeingCounted(boolean request) throws Exception {
    try (Connection delayed = connect(); Statement insert = delayed.createStatement()) {
      delayed.setAutoCommit(false);
      // Reserve the lower auto-increment ID, but keep the row invisible to the batch SELECT.
      String columns = request ? "requestTime, handlerDuration, httpMethod, preHandlerDuration" : "logTime, duration, operation";
      insert.executeUpdate("INSERT INTO " + rawTable(request) + " (" + columns
          + ", systemComponentName, lineNumber) VALUES ('2026-01-15 12:00:00', 1000, 'GET'"
          + (request ? ", 0" : "") + ", 'RESOURCE', 0)");
      seed(request); // a later ID commits first and is the only row visible to SELECT
      AggregationRollupDAO interleaved = new AggregationRollupDAO(sessions) {
        @Override public long[] foldLiveRequestBatch(RollupAccumulators acc, Instant from, Instant to, int limit) {
          long[] result = super.foldLiveRequestBatch(acc, from, to, limit);
          commitDelayed(result); return result;
        }
        @Override public long[] foldLiveCypherBatch(RollupAccumulators acc, Instant from, Instant to, int limit) {
          long[] result = super.foldLiveCypherBatch(acc, from, to, limit);
          commitDelayed(result); return result;
        }
        private void commitDelayed(long[] result) {
          assertEquals(1, result[0], "one row must still be invisible during SELECT");
          try { delayed.commit(); } catch (SQLException e) { throw new AssertionError(e); }
        }
      };
      assertEquals(1, aggregate(service(interleaved), request));
      LogAggregationService ordinary = service(new AggregationRollupDAO(sessions));
      long remaining = aggregate(ordinary, request);
      long counted = scalar("SELECT SUM(" + countColumn(request) + ") FROM " + rollupTable(request));
      long marked = scalar("SELECT COUNT(*) FROM " + rawTable(request) + " WHERE aggregatedAt IS NOT NULL");
      int pruned = prune(ordinary, request, TO);
      assertAll(
          () -> assertEquals(1, remaining, "the delayed row must be picked up by the next batch"),
          () -> assertEquals(2, counted, "both committed rows must be counted before removal"),
          () -> assertEquals(2, marked),
          () -> assertEquals(2, pruned));
    }
  }

  @ParameterizedTest @ValueSource(booleans = {true, false})
  void failureBetweenFlushAndMarkMustRollBackAndRetryOnce(boolean request) throws Exception {
    seed(request);
    AggregationRollupDAO failing = new AggregationRollupDAO(sessions) {
      @Override public int markLiveRequestRows(Instant from, Instant to, long max, Instant now) {
        throw new IllegalStateException("injected after rollup flush");
      }
      @Override public int markLiveCypherRows(Instant from, Instant to, long max, Instant now) {
        throw new IllegalStateException("injected after rollup flush");
      }
    };
    IllegalStateException failure = assertThrows(IllegalStateException.class,
        () -> aggregate(service(failing), request));
    assertEquals("injected after rollup flush", failure.getMessage());
    assertEquals(0, scalar("SELECT COUNT(*) FROM " + rollupTable(request)));
    assertEquals(0, scalar("SELECT COUNT(*) FROM " + rawTable(request) + " WHERE aggregatedAt IS NOT NULL"));
    LogAggregationService agg = service(new AggregationRollupDAO(sessions));
    assertEquals(1, aggregate(agg, request));
    assertEquals(0, aggregate(agg, request));
    assertEquals(1, scalar("SELECT SUM(" + countColumn(request) + ") FROM " + rollupTable(request)));
  }

  @ParameterizedTest @ValueSource(booleans = {true, false})
  void pruningMustLeaveUnaggregatedRowsAndRespectCutoff(boolean request) throws Exception {
    seed(request);
    LogAggregationService agg = service(new AggregationRollupDAO(sessions));
    assertEquals(0, prune(agg, request, TO));
    assertEquals(1, scalar("SELECT COUNT(*) FROM " + rawTable(request)));
    aggregate(agg, request);
    assertEquals(0, prune(agg, request, FROM));
    assertEquals(1, prune(agg, request, TO));
    assertEquals(0, prune(agg, request, TO));
    assertEquals(1, scalar("SELECT SUM(" + countColumn(request) + ") FROM " + rollupTable(request)));
  }

  private static void completeRequest() { for (char c : "SHE".toCharArray()) logger.handleLog(requestStage(c)); }
  private static void seed(boolean request) { if (request) completeRequest(); else logger.handleLog(cypher()); }
  private static AppLogMessage requestStage(char c) {
    return switch (c) {
      case 'S' -> event(AppLogType.REQUEST_FILTER, AppLogSubType.START, 0);
      case 'H' -> event(AppLogType.REQUEST_HANDLER, AppLogSubType.START, 1);
      case 'E' -> event(AppLogType.REQUEST_FILTER, AppLogSubType.END, 4).param(AppLogParam.STATUS, 503);
      default -> throw new IllegalArgumentException();
    };
  }
  private static AppLogMessage event(AppLogType type, AppLogSubType subType, long seconds) {
    AppLogMessage message = new AppLogMessage(SystemComponent.SERVER_RESOURCE, type, subType, "global", "local");
    try {
      Field time = AppLogMessage.class.getDeclaredField("logTime"); time.setAccessible(true);
      time.set(message, AT.plusSeconds(seconds));
    } catch (ReflectiveOperationException e) { throw new AssertionError(e); }
    return message.param(AppLogParam.HTTP_METHOD, "GET").param(AppLogParam.PATH, "/probe")
        .param(AppLogParam.CLASS_NAME, "ProbeResource").param(AppLogParam.METHOD_NAME, "get")
        .param(AppLogParam.USER_ID, "probe-user").param(AppLogParam.AUTH_SOURCE, "api_key")
        .param(AppLogParam.QUERY_PARAMETERS, Map.of());
  }
  private static AppLogMessage cypher() {
    AppLogMessage message = event(AppLogType.CYPHER_QUERY, AppLogSubType.FULL, 0)
        .param(AppLogParam.OPERATION, "read").param(AppLogParam.RUNNABLE_QUERY_HASH, "hash")
        .param(AppLogParam.RUNNABLE_QUERY, "RETURN 1").param(AppLogParam.INTERPOLATED_QUERY, "RETURN 1");
    message.setDuration(Duration.ofMillis(7));
    message.setStartTime(AT); message.setEndTime(AT.plusMillis(7));
    return message;
  }
  private static LogAggregationService service(AggregationRollupDAO dao) {
    return new UnitOfWorkAwareProxyFactory(bundle).create(LogAggregationService.class,
        new Class[]{AggregationRollupDAO.class, LogAggregationStateDAO.class},
        new Object[]{dao, new LogAggregationStateDAO(sessions)});
  }
  private static long aggregate(LogAggregationService service, boolean request) {
    return request ? service.aggregateLiveRequestBatch(FROM, TO, 10) : service.aggregateLiveCypherBatch(FROM, TO, 10);
  }
  private static int prune(LogAggregationService service, boolean request, Instant cutoff) {
    return request ? service.pruneRequests(cutoff, 10) : service.pruneCypher(cutoff, 10);
  }
  private static String rawTable(boolean request) { return request ? "log_request" : "log_cypher"; }
  private static String rollupTable(boolean request) { return request ? "agg_request_hourly" : "agg_cypher_hourly"; }
  private static String countColumn(boolean request) { return request ? "reqCount" : "execCount"; }
  private static Connection connect() throws SQLException { return DriverManager.getConnection(jdbcUrl, "root", ""); }
  private static long scalar(String query) throws SQLException {
    try (Connection c = connect(); Statement s = c.createStatement(); ResultSet rs = s.executeQuery(query)) {
      assertTrue(rs.next()); return rs.getLong(1);
    }
  }
  private static Object field(Class<?> owner, String name, Object target) throws Exception {
    Field field = owner.getDeclaredField(name); field.setAccessible(true); return field.get(target);
  }
  private static void await(CountDownLatch latch) {
    try { if (!latch.await(15, TimeUnit.SECONDS)) throw new AssertionError("coordination timeout"); }
    catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new AssertionError(e); }
  }
}
