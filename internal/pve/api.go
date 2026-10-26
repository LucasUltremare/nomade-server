package pve

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// Bool aceita 0/1, true/false e "0"/"1", que a API mistura conforme o endpoint.
type Bool bool

func (b *Bool) UnmarshalJSON(raw []byte) error {
	s := strings.Trim(string(raw), `"`)
	*b = s == "1" || s == "true"
	return nil
}

// Num aceita número ou número em string.
type Num float64

func (n *Num) UnmarshalJSON(raw []byte) error {
	s := strings.Trim(string(raw), `"`)
	if s == "" || s == "null" {
		*n = 0
		return nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil
	}
	*n = Num(f)
	return nil
}

type Version struct {
	Version string `json:"version"`
	Release string `json:"release"`
	RepoID  string `json:"repoid"`
}

type Realm struct {
	Realm   string `json:"realm"`
	Type    string `json:"type"`
	Comment string `json:"comment"`
	Default Bool   `json:"default"`
	TFA     string `json:"tfa"`
}

// ClusterStatus é uma linha de /cluster/status: o cluster ou um nó.
type ClusterStatus struct {
	Type    string `json:"type"` // "cluster" | "node"
	ID      string `json:"id"`
	Name    string `json:"name"`
	Nodes   int    `json:"nodes"`
	Quorate Bool   `json:"quorate"`
	IP      string `json:"ip"`
	Online  Bool   `json:"online"`
	Local   Bool   `json:"local"`
	NodeID  int    `json:"nodeid"`
}

// Resource é uma linha de /cluster/resources.
type Resource struct {
	ID         string  `json:"id"`
	Type       string  `json:"type"` // node | qemu | lxc | storage | pool | sdn
	Node       string  `json:"node"`
	VMID       int     `json:"vmid"`
	Name       string  `json:"name"`
	Status     string  `json:"status"`
	CPU        float64 `json:"cpu"`
	MaxCPU     float64 `json:"maxcpu"`
	Mem        int64   `json:"mem"`
	MaxMem     int64   `json:"maxmem"`
	Disk       int64   `json:"disk"`
	MaxDisk    int64   `json:"maxdisk"`
	Uptime     int64   `json:"uptime"`
	Template   Bool    `json:"template"`
	Tags       string  `json:"tags"`
	Storage    string  `json:"storage"`
	PluginType string  `json:"plugintype"`
	Shared     Bool    `json:"shared"`
	Content    string  `json:"content"`
	HAState    string  `json:"hastate"`
	Lock       string  `json:"lock"`
}

func (r Resource) IsGuest() bool { return r.Type == "qemu" || r.Type == "lxc" }

type NodeStatus struct {
	CPU     float64  `json:"cpu"`
	LoadAvg []string `json:"loadavg"`
	Uptime  int64    `json:"uptime"`
	CPUInfo struct {
		Model   string `json:"model"`
		CPUs    int    `json:"cpus"`
		Cores   int    `json:"cores"`
		Sockets int    `json:"sockets"`
		MHz     Num    `json:"mhz"`
	} `json:"cpuinfo"`
	Memory struct {
		Total int64 `json:"total"`
		Used  int64 `json:"used"`
		Free  int64 `json:"free"`
	} `json:"memory"`
	PVEVersion string `json:"pveversion"`
	KVersion   string `json:"kversion"`
}

// RRDPoint é uma amostra de rrddata. Os campos variam (nó vs guest) e
// amostras sem dado vêm só com "time", então fica como mapa.
type RRDPoint map[string]any

func (p RRDPoint) Time() int64 {
	f, _ := p.F("time")
	return int64(f)
}

// F devolve o campo numérico e se ele existe.
func (p RRDPoint) F(key string) (float64, bool) {
	switch v := p[key].(type) {
	case float64:
		return v, true
	case string:
		f, err := strconv.ParseFloat(v, 64)
		return f, err == nil
	}
	return 0, false
}

type Task struct {
	UPID      string `json:"upid"`
	Type      string `json:"type"`
	ID        string `json:"id"`
	Node      string `json:"node"`
	User      string `json:"user"`
	Status    string `json:"status"`
	StartTime int64  `json:"starttime"`
	EndTime   int64  `json:"endtime"`
}

type ZFSPool struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	Alloc  int64  `json:"alloc"`
	Free   int64  `json:"free"`
	Health string `json:"health"`
}

type Storage struct {
	Storage string `json:"storage"`
	Type    string `json:"type"`
	Content string `json:"content"`
	Total   int64  `json:"total"`
	Used    int64  `json:"used"`
	Avail   int64  `json:"avail"`
	Active  Bool   `json:"active"`
	Enabled Bool   `json:"enabled"`
	Shared  Bool   `json:"shared"`
}

func (c *Client) Realms(ctx context.Context) ([]Realm, error) {
	var out []Realm
	return out, c.Get(ctx, nil, "/access/domains", nil, &out)
}

func (c *Client) Version(ctx context.Context, a *Auth) (Version, error) {
	var out Version
	return out, c.Get(ctx, a, "/version", nil, &out)
}

func (c *Client) ClusterStatus(ctx context.Context, a *Auth) ([]ClusterStatus, error) {
	var out []ClusterStatus
	return out, c.Get(ctx, a, "/cluster/status", nil, &out)
}

func (c *Client) Resources(ctx context.Context, a *Auth) ([]Resource, error) {
	var out []Resource
	return out, c.Get(ctx, a, "/cluster/resources", nil, &out)
}

func (c *Client) NodeStatus(ctx context.Context, a *Auth, node string) (NodeStatus, error) {
	var out NodeStatus
	return out, c.Get(ctx, a, "/nodes/"+url.PathEscape(node)+"/status", nil, &out)
}

// NodeRRD aceita timeframe hour|day|week|month|year.
func (c *Client) NodeRRD(ctx context.Context, a *Auth, node, timeframe string) ([]RRDPoint, error) {
	var out []RRDPoint
	q := url.Values{"timeframe": {timeframe}, "cf": {"AVERAGE"}}
	return out, c.Get(ctx, a, "/nodes/"+url.PathEscape(node)+"/rrddata", q, &out)
}

// GuestRRD: kind é "qemu" ou "lxc".
func (c *Client) GuestRRD(ctx context.Context, a *Auth, node, kind string, vmid int, timeframe string) ([]RRDPoint, error) {
	var out []RRDPoint
	q := url.Values{"timeframe": {timeframe}, "cf": {"AVERAGE"}}
	path := fmt.Sprintf("/nodes/%s/%s/%d/rrddata", url.PathEscape(node), kind, vmid)
	return out, c.Get(ctx, a, path, q, &out)
}

func (c *Client) NodeTasks(ctx context.Context, a *Auth, node, typefilter string, since int64) ([]Task, error) {
	var out []Task
	q := url.Values{"limit": {"500"}, "source": {"all"}}
	if typefilter != "" {
		q.Set("typefilter", typefilter)
	}
	if since > 0 {
		q.Set("since", strconv.FormatInt(since, 10))
	}
	return out, c.Get(ctx, a, "/nodes/"+url.PathEscape(node)+"/tasks", q, &out)
}

func (c *Client) ZFSPools(ctx context.Context, a *Auth, node string) ([]ZFSPool, error) {
	var out []ZFSPool
	return out, c.Get(ctx, a, "/nodes/"+url.PathEscape(node)+"/disks/zfs", nil, &out)
}

func (c *Client) NodeStorage(ctx context.Context, a *Auth, node, content string) ([]Storage, error) {
	var out []Storage
	var q url.Values
	if content != "" {
		q = url.Values{"content": {content}, "enabled": {"1"}}
	}
	return out, c.Get(ctx, a, "/nodes/"+url.PathEscape(node)+"/storage", q, &out)
}

// Vzdump dispara um backup no nó e devolve o UPID da task.
func (c *Client) Vzdump(ctx context.Context, a *Auth, node string, opts url.Values) (string, error) {
	var upid string
	return upid, c.Post(ctx, a, "/nodes/"+url.PathEscape(node)+"/vzdump", opts, &upid)
}

// GuestAction: action é start|stop|shutdown|reboot|suspend|resume.
func (c *Client) GuestAction(ctx context.Context, a *Auth, node, kind string, vmid int, action string) (string, error) {
	var upid string
	path := fmt.Sprintf("/nodes/%s/%s/%d/status/%s", url.PathEscape(node), kind, vmid, action)
	err := c.Post(ctx, a, path, nil, &upid)
	return upid, err
}
