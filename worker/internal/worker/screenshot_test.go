package worker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
)

func TestEmptyScreenshotPayloadIsValidJSONWithNoImage(t *testing.T) {
	// Core rejects an empty `raw` for built-in tools and parses it with
	// JSON.parse, so "empty" has to be a well-formed envelope, not "".
	payload, err := emptyScreenshotPayload("example.com:8080")
	if err != nil {
		t.Fatalf("emptyScreenshotPayload: %v", err)
	}
	if payload == "" {
		t.Fatal("payload must not be empty: core rejects an empty raw for built-in tools")
	}

	var decoded struct {
		Screenshot string `json:"screenshot"`
		URL        string `json:"url"`
	}
	if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
		t.Fatalf("payload is not valid JSON: %v", err)
	}
	if decoded.Screenshot != "" {
		t.Fatalf("screenshot must be empty, got %q", decoded.Screenshot)
	}
	if decoded.URL != "http://example.com:8080" {
		t.Fatalf("url = %q, want the formatted target", decoded.URL)
	}
}

func TestTrimRodStackKeepsOnlyTheReason(t *testing.T) {
	// Shape of what rod.Try returns: the panic value, then the recovered
	// panic's goroutine stack.
	raw := "error value: &rod.NavigationError{Reason:\"net::ERR_SSL_PROTOCOL_ERROR\"}\n" +
		"goroutine 1342 [running]:\n" +
		"runtime/debug.Stack()\n" +
		"\t/usr/local/go/src/runtime/debug/stack.go:26 +0x5e\n"

	got := trimRodStack(raw)
	want := `&rod.NavigationError{Reason:"net::ERR_SSL_PROTOCOL_ERROR"}`
	if got != want {
		t.Fatalf("trimRodStack = %q, want %q", got, want)
	}
	if strings.Contains(got, "goroutine") {
		t.Fatal("the goroutine stack must not survive trimming")
	}
}

func TestTrimRodStackPassesThroughASingleLineError(t *testing.T) {
	const msg = "timeout loading page http://example.com"
	if got := trimRodStack(msg); got != msg {
		t.Fatalf("trimRodStack(%q) = %q, want it unchanged", msg, got)
	}
}

// An onion screenshot must reach the page only through the given proxy, with
// page scripts off (a script could reach out around the proxy).
func TestTakeScreenshotWithProxyRoutesThroughItWithoutScripts(t *testing.T) {
	b, l, err := launchBrowser(NewTuiLogger(nil, "test"))
	if err != nil {
		t.Skipf("chromium unavailable: %v", err)
	}
	defer func() { _ = b.Close(); l.Kill(); l.Cleanup() }()

	onion := strings.Repeat("a", 52) + "2345.onion"
	var mu sync.Mutex
	var seen []string
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Host+r.URL.Path)
		mu.Unlock()
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<html><body>hi<script>fetch("/js-ran")</script></body></html>`))
	}))
	defer proxy.Close()

	img, err := TakeScreenshotBase64(context.Background(), b, onion+":80", proxy.URL)
	if err != nil {
		t.Fatalf("screenshot: %v", err)
	}
	if img == "" {
		t.Fatal("empty screenshot")
	}
	mu.Lock()
	defer mu.Unlock()
	if !slices.Contains(seen, onion+":80/") && !slices.Contains(seen, onion+"/") {
		t.Fatalf("page did not load through the proxy: %v", seen)
	}
	for _, s := range seen {
		if strings.HasSuffix(s, "/js-ran") {
			t.Fatalf("page script ran: %v", seen)
		}
	}
}
