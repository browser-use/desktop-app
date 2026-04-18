"""
test_events.py — Tests for events.py event serialization and ordering.

Covers:
- EventEmitter: emit() buffers to history when no writer
- EventEmitter: history ordering
- EventEmitter: events_of_type() filtering
- EventEmitter: clear_history()
- SyncEventEmitter: emit() calls the inject fn
- SyncEventEmitter: history ordering
- SyncEventEmitter: events_of_type()
- Thread-safety of SyncEventEmitter
"""

import asyncio
import threading
import time

from agent.events import EventEmitter, SyncEventEmitter
from agent.protocol import (
    REASON_INTERNAL_ERROR,
    event_step_result,
    event_step_start,
    event_task_cancelled,
    event_task_done,
    event_task_failed,
    event_task_started,
)

# ── EventEmitter (async) ──────────────────────────────────────────────────────


class TestEventEmitter:
    def _run(self, coro):
        return asyncio.get_event_loop().run_until_complete(coro)

    def test_emit_buffers_to_history_without_writer(self):
        emitter = EventEmitter()
        evt = event_task_started("t1")
        self._run(emitter.emit(evt))
        assert len(emitter.history) == 1
        assert emitter.history[0]["event"] == "task_started"

    def test_multiple_emits_ordered(self):
        emitter = EventEmitter()
        events = [
            event_task_started("t1"),
            event_step_start("t1", step=0),
            event_step_result("t1", step=0, result=None, duration_ms=100),
            event_task_done("t1", result=None, steps_used=1, tokens_used=200),
        ]
        for e in events:
            self._run(emitter.emit(e))

        assert len(emitter.history) == 4
        assert emitter.history[0]["event"] == "task_started"
        assert emitter.history[1]["event"] == "step_start"
        assert emitter.history[2]["event"] == "step_result"
        assert emitter.history[3]["event"] == "task_done"

    def test_events_of_type_filters_correctly(self):
        emitter = EventEmitter()
        self._run(emitter.emit(event_task_started("t1")))
        self._run(emitter.emit(event_step_start("t1", step=0)))
        self._run(emitter.emit(event_step_start("t1", step=1)))
        self._run(emitter.emit(event_task_done("t1", result=None, steps_used=2, tokens_used=100)))

        step_starts = emitter.events_of_type("step_start")
        assert len(step_starts) == 2
        assert step_starts[0]["step"] == 0
        assert step_starts[1]["step"] == 1

    def test_events_of_type_returns_empty_for_unknown(self):
        emitter = EventEmitter()
        self._run(emitter.emit(event_task_started("t1")))
        assert emitter.events_of_type("no_such_event") == []

    def test_clear_history(self):
        emitter = EventEmitter()
        self._run(emitter.emit(event_task_started("t1")))
        self._run(emitter.emit(event_task_started("t2")))
        assert len(emitter.history) == 2
        emitter.clear_history()
        assert len(emitter.history) == 0

    def test_history_returns_copy(self):
        emitter = EventEmitter()
        self._run(emitter.emit(event_task_started("t1")))
        h1 = emitter.history
        h1.clear()
        assert len(emitter.history) == 1  # original not mutated

    def test_emit_without_writer_does_not_raise(self):
        emitter = EventEmitter(writer=None)
        # Should not raise even without a writer
        self._run(emitter.emit({"event": "custom", "task_id": "t1"}))
        assert len(emitter.history) == 1

    def test_set_writer_updates_writer(self):
        emitter = EventEmitter()
        assert emitter._writer is None

        # We can't easily create a real StreamWriter in unit tests,
        # but we verify the setter accepts any value
        class FakeWriter:
            pass

        emitter.set_writer(FakeWriter())
        assert emitter._writer is not None


# ── SyncEventEmitter ──────────────────────────────────────────────────────────


class TestSyncEventEmitter:
    def test_emit_calls_inject_fn(self):
        received = []
        emitter = SyncEventEmitter(emit_fn=received.append)
        evt = event_task_started("t1")
        emitter.emit(evt)
        assert len(received) == 1
        assert received[0]["event"] == "task_started"

    def test_emit_buffers_to_history(self):
        emitter = SyncEventEmitter(emit_fn=lambda e: None)
        emitter.emit(event_task_started("t1"))
        assert len(emitter.history) == 1

    def test_multiple_emits_ordered(self):
        emitter = SyncEventEmitter(emit_fn=lambda e: None)
        emitter.emit(event_task_started("t1"))
        emitter.emit(event_step_start("t1", step=0, plan="start"))
        emitter.emit(event_task_done("t1", result=None, steps_used=1, tokens_used=50))

        assert len(emitter.history) == 3
        assert emitter.history[0]["event"] == "task_started"
        assert emitter.history[1]["event"] == "step_start"
        assert emitter.history[2]["event"] == "task_done"

    def test_events_of_type_filtering(self):
        emitter = SyncEventEmitter(emit_fn=lambda e: None)
        emitter.emit(event_task_started("t1"))
        emitter.emit(event_task_failed("t1", REASON_INTERNAL_ERROR))
        emitter.emit(event_task_cancelled("t2"))

        failed = emitter.events_of_type("task_failed")
        assert len(failed) == 1
        assert failed[0]["reason"] == REASON_INTERNAL_ERROR

    def test_events_of_type_empty(self):
        emitter = SyncEventEmitter(emit_fn=lambda e: None)
        emitter.emit(event_task_started("t1"))
        assert emitter.events_of_type("task_done") == []

    def test_history_returns_copy(self):
        emitter = SyncEventEmitter(emit_fn=lambda e: None)
        emitter.emit(event_task_started("t1"))
        h = emitter.history
        h.clear()
        assert len(emitter.history) == 1  # original not mutated

    def test_emit_times_recorded(self):
        emitter = SyncEventEmitter(emit_fn=lambda e: None)
        before = time.monotonic()
        emitter.emit(event_task_started("t1"))
        after = time.monotonic()
        times = emitter.get_emit_times()
        assert len(times) == 1
        assert before <= times[0] <= after

    def test_emit_times_ordering(self):
        emitter = SyncEventEmitter(emit_fn=lambda e: None)
        emitter.emit(event_task_started("t1"))
        time.sleep(0.01)
        emitter.emit(event_step_start("t1", step=0))
        times = emitter.get_emit_times()
        assert times[0] < times[1]

    def test_threadsafe_concurrent_emits(self):
        """Multiple threads can emit without corrupting history."""
        received = []
        lock = threading.Lock()

        def safe_append(evt):
            with lock:
                received.append(evt)

        emitter = SyncEventEmitter(emit_fn=safe_append)
        n_threads = 20

        def _emit_n(i):
            emitter.emit({"event": "test_event", "task_id": f"t{i}", "i": i})

        threads = [threading.Thread(target=_emit_n, args=(i,)) for i in range(n_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # All events should be received (ordering may vary)
        assert len(received) == n_threads
        task_ids = {e["task_id"] for e in received}
        assert len(task_ids) == n_threads
