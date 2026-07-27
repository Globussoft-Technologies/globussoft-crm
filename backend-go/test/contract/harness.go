// Package contract provides a snapshot harness for comparing Node.js and Go API responses.
//
// Phase 0 scaffold:
//   - Record: send requests to the Node.js backend and store response JSON.
//   - Replay: send the same requests to the Go backend and compare.
//
// Full implementation is deferred until the first non-trivial module migration.
package contract

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Snapshot holds a recorded API response.
type Snapshot struct {
	Method   string            `json:"method"`
	Path     string            `json:"path"`
	Headers  map[string]string `json:"headers"`
	Status   int               `json:"status"`
	Body     any               `json:"body"`
	Redacted []string          `json:"redacted"`
}

// Record sends a request to the given base URL and stores the snapshot.
func Record(baseURL, method, path string, headers map[string]string, outDir string) (*Snapshot, error) {
	req, err := http.NewRequest(method, baseURL+path, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var parsed any
	if err := json.Unmarshal(body, &parsed); err != nil {
		parsed = string(body)
	}
	parsed = Redact(parsed, "id", "createdAt", "updatedAt", "jwt", "token", "passwordHash", "signature")
	snap := &Snapshot{
		Method:   method,
		Path:     path,
		Headers:  headers,
		Status:   resp.StatusCode,
		Body:     parsed,
		Redacted: []string{"id", "createdAt", "updatedAt", "jwt", "token", "passwordHash", "signature"},
	}
	if err := Save(snap, outDir); err != nil {
		return nil, err
	}
	return snap, nil
}

// Save writes a snapshot to disk.
func Save(snap *Snapshot, outDir string) error {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return err
	}
	name := strings.ReplaceAll(snap.Path, "/", "_") + ".json"
	if name == "_.json" {
		name = "root.json"
	}
	return os.WriteFile(filepath.Join(outDir, name), b, 0o644)
}

// Redact recursively replaces sensitive field values with a placeholder.
func Redact(data any, fields ...string) any {
	fieldSet := make(map[string]bool)
	for _, f := range fields {
		fieldSet[f] = true
	}
	return redactValue(data, fieldSet)
}

func redactValue(data any, fieldSet map[string]bool) any {
	switch v := data.(type) {
	case map[string]any:
		out := make(map[string]any)
		for k, val := range v {
			if fieldSet[k] {
				out[k] = "<redacted>"
			} else {
				out[k] = redactValue(val, fieldSet)
			}
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, val := range v {
			out[i] = redactValue(val, fieldSet)
		}
		return out
	default:
		return data
	}
}

// Compare returns a human-readable diff string if the snapshots differ.
func Compare(expected, actual any) string {
	expJSON, _ := json.MarshalIndent(expected, "", "  ")
	actJSON, _ := json.MarshalIndent(actual, "", "  ")
	if string(expJSON) == string(actJSON) {
		return ""
	}
	return fmt.Sprintf("expected:\n%s\n\nactual:\n%s", expJSON, actJSON)
}
