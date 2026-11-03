package worker

import (
	"sort"
	"sync"

	"oasm-worker/internal/execution"
)

// starter is the slice of execution.Manager the claim filter needs.
type starter interface {
	CanStart(spec execution.JobSpec) bool
}

// connectorSpecs remembers the image and limits each connector tool was last
// claimed with, so the poller can tell Core which tools this node cannot start
// right now. Without it the worker claimed every job it had a concurrency slot
// for and queued the surplus locally, where it starved and failed while other
// workers sat idle.
type connectorSpecs struct {
	mu     sync.Mutex
	byTool map[string]execution.JobSpec
}

func newConnectorSpecs() *connectorSpecs {
	return &connectorSpecs{byTool: map[string]execution.JobSpec{}}
}

// claimedConnectors is fed by every connector job this worker processes.
var claimedConnectors = newConnectorSpecs()

func (c *connectorSpecs) remember(spec execution.JobSpec) {
	if spec.Tool == "" || spec.Image == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.byTool[spec.Tool] = execution.JobSpec{Tool: spec.Tool, Image: spec.Image, Limits: spec.Limits}
}

// saturated lists the known tools (sorted) whose jobs could not start now.
// A tool never seen is not listed: its first claim may overflow, and the
// surplus is released straight back (see processConnectorJob).
func (c *connectorSpecs) saturated(s starter) []string {
	if s == nil {
		return nil
	}
	c.mu.Lock()
	specs := make([]execution.JobSpec, 0, len(c.byTool))
	for _, spec := range c.byTool {
		specs = append(specs, spec)
	}
	c.mu.Unlock()

	var out []string
	for _, spec := range specs {
		if !s.CanStart(spec) {
			out = append(out, spec.Tool)
		}
	}
	sort.Strings(out)
	return out
}
