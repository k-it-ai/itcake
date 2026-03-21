package svclist

// ServiceInfo represents a running system service.
type ServiceInfo struct {
	Name    string `json:"name"`
	Status  string `json:"status"`
	Enabled *bool  `json:"enabled"`
}
