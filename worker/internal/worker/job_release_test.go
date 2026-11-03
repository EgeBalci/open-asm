package worker

import (
	"context"
	"testing"
	"time"

	"oasm-worker/internal/connector"
	"oasm-worker/internal/execution"
	pb "oasm-worker/internal/gen/jobs_registry"
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

// TestProcessConnectorJobReleasesSurplus: a job claimed while its image's pool
// is full goes straight back to Core when Core supports Release, instead of
// holding a slot here until the pool frees or the wait budget runs out.
func TestProcessConnectorJobReleasesSurplus(t *testing.T) {
	resetWorkerGlobals()
	oldBackoff := swapImageBackoff(execution.NewImageBackoff())
	t.Cleanup(func() { imageBackoff = oldBackoff })

	client, jobsSrv, fakeRT := newWorkerTestSetup(t)
	jobsSrv.releaseOK = true
	mgr := execution.NewManager(fakeRT, 0)
	mgr.SetPool(execution.NewPoolManager(0, 1, 0))
	const image = "ghcr.io/oasm-platform/connector-nuclei:3.11.1"
	if _, err := mgr.Submit(context.Background(), execution.JobSpec{Tool: "nuclei", Image: image, JobID: "occupier"}); err != nil {
		t.Fatalf("Submit (occupier): %v", err)
	}

	events := make(chan TuiEvent, 64)
	start := time.Now()
	hadJob, async := processConnectorJob(context.Background(),
		&pb.Job{Id: "job-surplus", Tool: "nuclei", Image: image},
		client, events, mgr, connector.NewProxy(), func() {}, time.Now(), "vulnerabilities")

	if !hadJob || async {
		t.Fatalf("hadJob=%v async=%v, want true/false (caller releases the slot)", hadJob, async)
	}
	if waited := time.Since(start); waited > time.Second {
		t.Fatalf("surplus job waited %s for a slot instead of being released", waited)
	}
	if len(jobsSrv.released) != 1 || jobsSrv.released[0] != "job-surplus" {
		t.Fatalf("released %v, want [job-surplus]", jobsSrv.released)
	}
	if len(jobsSrv.results) != 0 {
		t.Fatalf("a released job must not be reported failed: %+v", jobsSrv.results)
	}
	if got := claimedConnectors.saturated(mgr); len(got) != 1 || got[0] != "nuclei" {
		t.Fatalf("saturated = %v, want [nuclei] so the next claim skips it", got)
	}
}
