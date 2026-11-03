package worker

import (
	"slices"
	"testing"

	"oasm-worker/internal/execution"
)

type fakeStarter map[string]bool // image -> can start

func (f fakeStarter) CanStart(spec execution.JobSpec) bool { return f[spec.Image] }

func TestConnectorSpecsSaturated(t *testing.T) {
	c := newConnectorSpecs()
	c.remember(execution.JobSpec{Tool: "nuclei", Image: "img/nuclei"})
	c.remember(execution.JobSpec{Tool: "nmap", Image: "img/nmap"})
	c.remember(execution.JobSpec{Tool: "httpx"}) // built-in: no image, never excluded

	got := c.saturated(fakeStarter{"img/nuclei": false, "img/nmap": true})
	if !slices.Equal(got, []string{"nuclei"}) {
		t.Fatalf("saturated = %v, want [nuclei]", got)
	}
	if got := c.saturated(nil); got != nil {
		t.Fatalf("no manager: got %v, want none", got)
	}
}
