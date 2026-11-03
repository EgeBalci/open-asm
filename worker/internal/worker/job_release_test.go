package worker

import (
	"context"
	"testing"
)

// TestReleaseOrFail: a job the worker could not start goes back to Core's
// queue when Core supports Release (no error result, no retry spent), and
// falls back to the error report on an older Core.
func TestReleaseOrFail(t *testing.T) {
	client, jobsSrv, _ := newWorkerTestSetup(t)
	events := make(chan TuiEvent, 16)

	jobsSrv.releaseOK = true
	releaseOrFail(context.Background(), client, events, "job-1", "ports_scanner", "no slot")
	if len(jobsSrv.released) != 1 || jobsSrv.released[0] != "job-1" {
		t.Fatalf("released %v, want [job-1]", jobsSrv.released)
	}
	if len(jobsSrv.results) != 0 {
		t.Fatalf("a released job must not also be reported failed: %+v", jobsSrv.results)
	}

	jobsSrv.releaseOK = false
	releaseOrFail(context.Background(), client, events, "job-2", "ports_scanner", "no slot")
	if len(jobsSrv.results) != 1 || jobsSrv.results[0].jobID != "job-2" || !jobsSrv.results[0].isError {
		t.Fatalf("older Core: want one error result for job-2, got %+v", jobsSrv.results)
	}
}
