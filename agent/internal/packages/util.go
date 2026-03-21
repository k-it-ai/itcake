package packages

import "strings"

func splitLines(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

func splitFields(s string) []string {
	return strings.Fields(strings.TrimSpace(s))
}
