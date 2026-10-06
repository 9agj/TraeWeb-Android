// 管理面板（/admin）：只读查询，无鉴权（本地面板）；CLI 操作留待开发。
package server

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"trae2api-web/internal/pool"
)

//go:embed admin.html
var adminPageHTML []byte

// adminPage 返回内嵌 HTML 面板（深色简洁风，无外部依赖）。
//
// 把 APIKey 注入页面：控制台要展示当前密钥并支持改钥，页内拿不到环境变量，
// 所以在这里塞一个全局常量。Key 本来就是本机回环面板自己的凭据，不构成额外暴露。
func (h *Handler) adminPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	body := adminPageHTML
	if len(body) > 0 && h.cfg.APIKey != "" {
		inject := []byte("<script>window.__TW2A_KEY__=" + jsonString(h.cfg.APIKey) + ";</script>\n</head>")
		body = bytes.Replace(body, []byte("</head>"), inject, 1)
	}
	_, _ = w.Write(body)
}

// jsonString 把一个字符串编码成 JSON 字面量（含引号），用于安全注入 <script>。
func jsonString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	// 防止 </script> 提前闭合
	out := strings.ReplaceAll(string(b), "</", "<\\/")
	return out
}

// adminCredits 查询全部账号的实时额度 + 签到状态（并发拉取上游）。
func (h *Handler) adminCredits(w http.ResponseWriter, r *http.Request) {
	type acct struct {
		UID            string `json:"uid"`
		Nickname       string `json:"nickname"`
		Remain         int64  `json:"remain"`
		Limit          int64  `json:"limit"`
		Used           int64  `json:"used"`
		Packs          int    `json:"packs"`
		CheckedIn      bool   `json:"checked_in"`
		CheckinCredits int64  `json:"checkin_credits"`
		CheckinEnable  bool   `json:"checkin_enable"`
		Cooling        bool   `json:"cooling"`
		CoolKind       string `json:"cool_kind,omitempty"`
		Disabled       bool   `json:"disabled"`
		Enabled        bool   `json:"enabled"`
		Error          string `json:"error,omitempty"`
	}

	st := h.cfg.Pool.List()
	out := make([]acct, len(st))
	var wg sync.WaitGroup
	for i, s := range st {
		wg.Add(1)
		go func(i int, s pool.Status) {
			defer wg.Done()
			a := h.cfg.Pool.AuthByUID(s.UID)
			if a == nil {
				out[i] = acct{UID: s.UID, Nickname: s.Nickname, Error: "no auth found"}
				return
			}
			var ac acct
			ac.UID = s.UID
			ac.Nickname = s.Nickname
			ac.Cooling = s.Cooling
			ac.CoolKind = s.CoolKind
			ac.Disabled = s.Disabled
			ac.Enabled = s.Enabled
			remain, limit, used, packs, err := h.cfg.Upstream.EntUsage(a)
			if err != nil {
				ac.Error = "ent_usage: " + err.Error()
			} else {
				ac.Remain, ac.Limit, ac.Used, ac.Packs = remain, limit, used, packs
			}
			checkedIn, credits, enable, cerr := h.cfg.Upstream.CheckinStatus(a)
			if cerr != nil {
				if ac.Error != "" {
					ac.Error += "; "
				}
				ac.Error += "checkin: " + cerr.Error()
			} else {
				ac.CheckedIn, ac.CheckinCredits, ac.CheckinEnable = checkedIn, credits, enable
			}
			out[i] = ac
		}(i, s)
	}
	wg.Wait()

	// 汇总：控制台顶部「Token 余额」卡片直接用，避免前端重复计算口径
	var sumRemain, sumLimit, sumUsed int64
	var sumCheckin int64
	healthy := 0
	for _, a := range out {
		if a.Error != "" {
			continue
		}
		sumRemain += a.Remain
		sumLimit += a.Limit
		sumUsed += a.Used
		if a.CheckinEnable {
			sumCheckin += a.CheckinCredits
		}
		if !a.Cooling && !a.Disabled && a.Enabled {
			healthy++
		}
	}
	pct := 0.0
	if sumLimit > 0 {
		pct = float64(sumRemain) / float64(sumLimit) * 100
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"fetched_at": time.Now().Format("2006-01-02 15:04:05"),
		"accounts":   out,
		"summary": map[string]any{
			"remain":          sumRemain,
			"limit":           sumLimit,
			"used":            sumUsed,
			"checkin_pending": sumCheckin,
			"remain_pct":      pct,
			"healthy":         healthy,
			"total":           len(out),
		},
	})
}

// adminUsage GET /admin/api/usage：调用用量统计（今日 / 累计 / 最近明细）。
func (h *Handler) adminUsage(w http.ResponseWriter, r *http.Request) {
	if h.usage == nil {
		writeJSON(w, http.StatusOK, UsageSnapshot{})
		return
	}
	writeJSON(w, http.StatusOK, h.usage.Snapshot())
}

// adminUsageReset POST /admin/api/usage/reset：清零统计。
func (h *Handler) adminUsageReset(w http.ResponseWriter, r *http.Request) {
	if h.usage != nil {
		h.usage.Reset()
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
