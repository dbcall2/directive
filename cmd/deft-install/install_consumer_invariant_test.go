package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReassertInstallConsumerInvariant_RestoresOverwrittenAgentsAndGitignore(t *testing.T) {
	tmp := t.TempDir()
	var out bytes.Buffer
	w := NewWizard(strings.NewReader(""), &out, false)

	if err := WriteAgentsMD(w, tmp); err != nil {
		t.Fatalf("seed WriteAgentsMD: %v", err)
	}
	if _, err := EnsureGitignoreLines(w, tmp); err != nil {
		t.Fatalf("seed EnsureGitignoreLines: %v", err)
	}

	if err := os.WriteFile(filepath.Join(tmp, "AGENTS.md"), []byte("# My App\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmp, ".gitignore"), []byte("node_modules\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := ReassertInstallConsumerInvariant(w, tmp); err != nil {
		t.Fatalf("reassert: %v", err)
	}
	agents, err := os.ReadFile(filepath.Join(tmp, "AGENTS.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(agents), "deft:managed-section") {
		t.Fatalf("AGENTS.md missing managed section after reassert:\n%s", agents)
	}
	ignore, err := os.ReadFile(filepath.Join(tmp, ".gitignore"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(ignore), ".deft-cache/") {
		t.Fatalf(".gitignore missing canonical cache line after reassert:\n%s", ignore)
	}
}

func TestReassertInstallConsumerInvariant_NoOpWhenAlreadyPresent(t *testing.T) {
	tmp := t.TempDir()
	var out bytes.Buffer
	w := NewWizard(strings.NewReader(""), &out, false)
	if err := WriteAgentsMD(w, tmp); err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureGitignoreLines(w, tmp); err != nil {
		t.Fatal(err)
	}
	beforeAgents, _ := os.ReadFile(filepath.Join(tmp, "AGENTS.md"))
	if err := ReassertInstallConsumerInvariant(w, tmp); err != nil {
		t.Fatalf("reassert: %v", err)
	}
	afterAgents, _ := os.ReadFile(filepath.Join(tmp, "AGENTS.md"))
	if string(beforeAgents) != string(afterAgents) {
		t.Fatal("expected no AGENTS.md rewrite when invariant already holds")
	}
}

func TestInstallConsumerInvariantRefuseMessage_NamesCheckedFiles(t *testing.T) {
	both := installConsumerInvariantRefuseMessage(true, true)
	if strings.Contains(both, "pin") {
		t.Fatalf("Go refuse named pin though the Go invariant does not check it: %s", both)
	}
	if !strings.Contains(both, "AGENTS.md") {
		t.Fatalf("expected AGENTS.md in %s", both)
	}
	if !strings.Contains(both, ".gitignore") {
		t.Fatalf("expected .gitignore in %s", both)
	}
	if !strings.Contains(both, "directive init") {
		t.Fatalf("expected recovery verb in %s", both)
	}

	ignoreOnly := installConsumerInvariantRefuseMessage(false, true)
	if strings.Contains(ignoreOnly, "AGENTS.md") {
		t.Fatalf("gitignore-only refuse named AGENTS.md: %s", ignoreOnly)
	}
	if strings.Contains(ignoreOnly, "pin") {
		t.Fatalf("gitignore-only refuse named pin: %s", ignoreOnly)
	}
	if !strings.Contains(ignoreOnly, ".gitignore") {
		t.Fatalf("expected .gitignore in %s", ignoreOnly)
	}

	agentsOnly := installConsumerInvariantRefuseMessage(true, false)
	if strings.Contains(agentsOnly, ".gitignore") {
		t.Fatalf("agents-only refuse named .gitignore: %s", agentsOnly)
	}
	if !strings.Contains(agentsOnly, "AGENTS.md") {
		t.Fatalf("expected AGENTS.md in %s", agentsOnly)
	}
}
