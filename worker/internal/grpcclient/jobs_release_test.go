package grpcclient

import (
	"context"
	"errors"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	jobsRegistry "oasm-worker/internal/gen/jobs_registry"
)

// releaseFake answers Release only; any other RPC panics on the nil embed.
type releaseFake struct {
	jobsRegistry.JobsRegistryServiceClient
	resp *jobsRegistry.JobResponse
	err  error
	got  *jobsRegistry.ReleaseJobRequest
}

func (f *releaseFake) Release(_ context.Context, in *jobsRegistry.ReleaseJobRequest, _ ...grpc.CallOption) (*jobsRegistry.JobResponse, error) {
	f.got = in
	return f.resp, f.err
}

func TestReleaseJob(t *testing.T) {
	ok := &releaseFake{resp: &jobsRegistry.JobResponse{Success: true}}
	if err := (&Client{jobs: ok}).ReleaseJob(context.Background(), "job-1", "no slot"); err != nil {
		t.Fatalf("release: %v", err)
	}
	if ok.got.GetJobId() != "job-1" || ok.got.GetReason() != "no slot" {
		t.Fatalf("sent %+v", ok.got)
	}

	old := &releaseFake{err: status.Error(codes.Unimplemented, "unknown method Release")}
	if err := (&Client{jobs: old}).ReleaseJob(context.Background(), "job-1", ""); !errors.Is(err, ErrReleaseUnsupported) {
		t.Fatalf("older Core: got %v, want ErrReleaseUnsupported", err)
	}

	gone := &releaseFake{resp: &jobsRegistry.JobResponse{Success: false}}
	if err := (&Client{jobs: gone}).ReleaseJob(context.Background(), "job-1", ""); err == nil || errors.Is(err, ErrReleaseUnsupported) {
		t.Fatalf("job not held: got %v, want a plain error", err)
	}
}
