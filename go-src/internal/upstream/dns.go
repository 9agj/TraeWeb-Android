// dns.go —— Android 上的 DNS 解析。
//
// 背景：Android 用 netd 统一管理 DNS，**没有 /etc/resolv.conf**。
// 而 Go 的纯解析器（CGO_ENABLED=0 时唯一选择）只读这个文件，
// 读不到就退回到 [::1]:53，然后连接被拒：
//
//	dial tcp: lookup api.trae.cn on [::1]:53: read udp [::1]:36021->[::1]:53: connection refused
//
// 结果：relay 根本无法访问上游 —— 余额显示 0、签到失败、对话 503。
//
// 解法：由 App 侧（Java 的 ConnectivityManager 能正常拿到系统 DNS）
// 把 DNS 服务器地址通过环境变量 TW2A_DNS 传进来，这里构建自定义解析器。
package upstream

import (
	"context"
	"log"
	"net"
	"os"
	"strings"
	"time"
)

// 兜底 DNS：App 未提供时使用。选国内可达性好的公共 DNS。
var fallbackDNS = []string{"223.5.5.5", "119.29.29.29", "8.8.8.8"}

// dnsServers 从环境变量读取 DNS 服务器列表（逗号分隔），为空则用兜底值。
func dnsServers() []string {
	raw := strings.TrimSpace(os.Getenv("TW2A_DNS"))
	if raw == "" {
		return fallbackDNS
	}
	var out []string
	for _, s := range strings.Split(raw, ",") {
		s = strings.TrimSpace(s)
		if s != "" {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return fallbackDNS
	}
	return out
}

// newResolver 构建一个直接向指定 DNS 服务器查询的解析器。
//
// 逐个尝试列表中的服务器，任一可用即返回 —— 单个 DNS 不可达时不影响整体。
func newResolver() *net.Resolver {
	servers := dnsServers()
	addrs := make([]string, 0, len(servers))
	for _, s := range servers {
		addrs = append(addrs, net.JoinHostPort(s, "53"))
	}
	return &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			d := net.Dialer{Timeout: 5 * time.Second}
			log.Printf("[dns] 自定义解析器被调用 network=%s 服务器=%v", network, addrs)
			var lastErr error
			for _, addr := range addrs {
				// 先 UDP，失败再试 TCP（大响应或截断时需要）
				if c, err := d.DialContext(ctx, "udp", addr); err == nil {
					return c, nil
				} else {
					lastErr = err
				}
				if c, err := d.DialContext(ctx, "tcp", addr); err == nil {
					return c, nil
				} else {
					lastErr = err
				}
			}
			return nil, lastErr
		},
	}
}

// newDialer 返回使用自定义解析器的 Dialer。
// 挂在 http.Transport.DialContext 上，让所有出站请求都走它。
func newDialer() *net.Dialer {
	return &net.Dialer{
		Timeout:   30 * time.Second,
		KeepAlive: 30 * time.Second,
		Resolver:  newResolver(),
	}
}
