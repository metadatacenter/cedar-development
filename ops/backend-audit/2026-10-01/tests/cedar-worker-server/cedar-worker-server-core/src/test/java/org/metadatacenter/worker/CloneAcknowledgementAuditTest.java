package org.metadatacenter.worker;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.metadatacenter.id.CedarTemplateId;
import org.metadatacenter.server.queue.util.CloneInstancesQueueService;
import org.metadatacenter.server.queue.util.EmbeddedRedis;
import org.metadatacenter.server.queue.util.QueueTestConfig;
import org.metadatacenter.server.resource.CloneInstancesExecutorService;
import org.metadatacenter.server.resource.CloneInstancesQueueEvent;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

/** A failure after successful side effects must not replay non-idempotent cloning. */
class CloneAcknowledgementAuditTest {
  @ParameterizedTest
  @ValueSource(booleans = {false, true})
  void successfulCloneIsNotRepeatedWhenOnlyAcknowledgementFails(boolean throwOnAck) throws Exception {
    try (EmbeddedRedis redis = EmbeddedRedis.start()) {
      CloneInstancesQueueService queue = spy(new CloneInstancesQueueService(QueueTestConfig.onPort(redis.port())));
      CloneInstancesExecutorService executor = mock(CloneInstancesExecutorService.class);
      AtomicInteger clones = new AtomicInteger();
      doAnswer(call -> { clones.incrementAndGet(); return null; }).when(executor).handleEvent(any());
      AtomicInteger acknowledgements = new AtomicInteger();
      CountDownLatch acknowledged = new CountDownLatch(1);
      doAnswer(call -> {
        if (acknowledgements.incrementAndGet() == 1) {
          if (throwOnAck) throw new IllegalStateException("Redis connection interrupted during acknowledgement");
          return false;
        }
        boolean result = (boolean) call.callRealMethod();
        acknowledged.countDown();
        return result;
      }).when(queue).acknowledge(anyString());

      CloneInstancesQueueProcessor processor = new CloneInstancesQueueProcessor(queue, executor);
      processor.start();
      try {
        queue.enqueueEvent(new CloneInstancesQueueEvent(
            CedarTemplateId.build("https://repo.metadatacenter.orgx/templates/ack-old"),
            CedarTemplateId.build("https://repo.metadatacenter.orgx/templates/ack-new"), "ack audit"));
        assertTrue(acknowledged.await(10, TimeUnit.SECONDS), "the recovered Redis must accept acknowledgement");
        assertEquals(0, queue.inFlightCount());
        assertEquals(1, clones.get(), "only acknowledgement failed; successful cloning must run once");
      } finally {
        processor.stop();
      }
    }
  }
}
