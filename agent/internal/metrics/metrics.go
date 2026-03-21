package metrics

// SystemMetrics contains collected system metrics for check-in.
type SystemMetrics struct {
	CPUPercent      *float64 `json:"cpuPercent"`
	MemoryUsedBytes *int64   `json:"memoryUsedBytes"`
	MemoryTotalBytes *int64  `json:"memoryTotalBytes"`
	DiskUsedBytes   *int64   `json:"diskUsedBytes"`
	DiskTotalBytes  *int64   `json:"diskTotalBytes"`
	LoadAvg1        *float64 `json:"loadAvg1"`
	LoadAvg5        *float64 `json:"loadAvg5"`
	LoadAvg15       *float64 `json:"loadAvg15"`
	UptimeSeconds   *int64   `json:"uptimeSeconds"`
}

func ptrFloat(v float64) *float64 { return &v }
func ptrInt64(v int64) *int64     { return &v }
