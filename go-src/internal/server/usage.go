// usage.go —— 调用用量统计。
//
// 数据来源是每次上游响应里的 token_usage 事件，字段真实、无需估算：
//
//	{"prompt_tokens":21,"completion_tokens":142,"total_tokens":163,"reasoning_tokens":135}
//
// 统计维度：
//   - 累计（进程启动至今）
//   - 今日（按本地日期切分）
//   - 最近 N 次调用明细
//
// 只保留内存态：这类计数重启后归零可以接受，落盘反而增加写放大与
// 崩溃时状态不一致的风险。需要持久化时再加。
package server

import (
	"sync"
	"time"
)

// recentLimit 最近调用记录的保留条数。
const recentLimit = 50

// UsageRecord 一次调用的用量明细。
type UsageRecord struct {
	Time             string `json:"time"`    // HH:MM:SS
	Model            string `json:"model"`   // 客户端请求的模型名
	Account          string `json:"account"` // 昵称或 UID
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
	ReasoningTokens  int64  `json:"reasoning_tokens"`
	TotalTokens      int64  `json:"total_tokens"`
	DurationMS       int64  `json:"duration_ms"`
	Stream           bool   `json:"stream"`
	OK               bool   `json:"ok"`
	Error            string `json:"error,omitempty"`
}

// UsageBucket 一组聚合计数。
type UsageBucket struct {
	Requests         int64 `json:"requests"`
	Success          int64 `json:"success"`
	Failed           int64 `json:"failed"`
	PromptTokens     int64 `json:"prompt_tokens"`
	CompletionTokens int64 `json:"completion_tokens"`
	ReasoningTokens  int64 `json:"reasoning_tokens"`
	TotalTokens      int64 `json:"total_tokens"`
}

func (b *UsageBucket) add(r UsageRecord) {
	b.Requests++
	if r.OK {
		b.Success++
	} else {
		b.Failed++
	}
	b.PromptTokens += r.PromptTokens
	b.CompletionTokens += r.CompletionTokens
	b.ReasoningTokens += r.ReasoningTokens
	b.TotalTokens += r.TotalTokens
}

// UsageTracker 用量统计器（并发安全）。
type UsageTracker struct {
	mu     sync.Mutex
	total  UsageBucket
	today  UsageBucket
	day    string // 今日对应的日期（YYYY-MM-DD），跨天时重置 today
	recent []UsageRecord
}

// NewUsageTracker 创建统计器。
func NewUsageTracker() *UsageTracker {
	return &UsageTracker{day: time.Now().Format("2006-01-02")}
}

// Record 记录一次调用。
func (u *UsageTracker) Record(r UsageRecord) {
	u.mu.Lock()
	defer u.mu.Unlock()

	// 跨天重置「今日」
	d := time.Now().Format("2006-01-02")
	if d != u.day {
		u.day = d
		u.today = UsageBucket{}
	}

	u.total.add(r)
	u.today.add(r)

	// 最近记录：新的放前面，超出上限截断
	u.recent = append([]UsageRecord{r}, u.recent...)
	if len(u.recent) > recentLimit {
		u.recent = u.recent[:recentLimit]
	}
}

// UsageSnapshot 对外快照。
type UsageSnapshot struct {
	Today  UsageBucket   `json:"today"`
	Total  UsageBucket   `json:"total"`
	Recent []UsageRecord `json:"recent"`
	Day    string        `json:"day"`
}

// Snapshot 读取当前统计。
func (u *UsageTracker) Snapshot() UsageSnapshot {
	u.mu.Lock()
	defer u.mu.Unlock()
	recent := make([]UsageRecord, len(u.recent))
	copy(recent, u.recent)
	return UsageSnapshot{
		Today:  u.today,
		Total:  u.total,
		Recent: recent,
		Day:    u.day,
	}
}

// Reset 清零（供控制台使用）。
func (u *UsageTracker) Reset() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.total = UsageBucket{}
	u.today = UsageBucket{}
	u.recent = nil
	u.day = time.Now().Format("2006-01-02")
}
