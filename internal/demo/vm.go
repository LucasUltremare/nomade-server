package demo

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/coder/websocket"
)

// VMs no PVE falso: snapshots, clone, template, apagar, console VNC (um
// servidor RFB mínimo que desenha uma "área de trabalho" estática).

type snap struct {
	name, desc, parent string
	time               int64
	ram                bool
}

func (s *Server) routesVM(mux *http.ServeMux) {
	for _, k := range []string{"lxc", "qemu"} {
		g := "/api2/json/nodes/{node}/" + k + "/{vmid}"
		mux.HandleFunc("GET "+g+"/snapshot", s.auth(s.snapList))
		mux.HandleFunc("POST "+g+"/snapshot", s.auth(s.snapCreate))
		mux.HandleFunc("POST "+g+"/snapshot/{snap}/rollback", s.auth(s.snapRollback))
		mux.HandleFunc("DELETE "+g+"/snapshot/{snap}", s.auth(s.snapDelete))
		mux.HandleFunc("POST "+g+"/clone", s.auth(s.clone))
		mux.HandleFunc("POST "+g+"/template", s.auth(s.makeTemplate))
		mux.HandleFunc("GET "+g+"/status/current", s.auth(func(w http.ResponseWriter, r *http.Request) {
			id := s.vmidOf(r)
			if !s.hasGuest(id) {
				fail(w, 500, "no such guest")
				return
			}
			reply(w, map[string]any{"status": s.statusOf(id), "vmid": id})
		}))
		mux.HandleFunc("DELETE "+g, s.auth(s.destroy))
	}
	mux.HandleFunc("POST /api2/json/nodes/{node}/qemu/{vmid}/vncproxy", s.auth(s.vncproxy))
	mux.HandleFunc("GET /api2/json/nodes/{node}/qemu/{vmid}/vncwebsocket", s.auth(s.vncSocket))
}

func (s *Server) initVM() {
	day := time.Now().Truncate(24 * time.Hour)
	s.snaps = map[int][]snap{
		102: {
			{name: "antes_upgrade", desc: "Antes de atualizar o kernel", time: day.Add(-9 * 24 * time.Hour).Unix(), ram: true},
			{name: "build_ok", desc: "Ambiente de build funcionando", parent: "antes_upgrade", time: day.Add(-2 * 24 * time.Hour).Unix()},
		},
		103: {{name: "mundo_v1", desc: "Backup do mundo antes do mod", time: day.Add(-5 * 24 * time.Hour).Unix()}},
	}
}

func (s *Server) vmidOf(r *http.Request) int {
	id, _ := strconv.Atoi(r.PathValue("vmid"))
	return id
}

// ---------- snapshots ----------

func (s *Server) snapList(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.snaps[s.vmidOf(r)]
	out := []map[string]any{}
	last := ""
	for _, sn := range list {
		row := map[string]any{"name": sn.name, "description": sn.desc, "snaptime": sn.time}
		if sn.parent != "" {
			row["parent"] = sn.parent
		}
		if sn.ram {
			row["vmstate"] = 1
		}
		out = append(out, row)
		last = sn.name
	}
	cur := map[string]any{"name": "current", "description": "You are here!", "running": 1}
	if last != "" {
		cur["parent"] = last
	}
	reply(w, append(out, cur))
}

func (s *Server) snapCreate(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	id := s.vmidOf(r)
	name := r.PostForm.Get("snapname")
	s.mu.Lock()
	for _, sn := range s.snaps[id] {
		if sn.name == name {
			s.mu.Unlock()
			fail(w, 500, "snapshot name '"+name+"' already used")
			return
		}
	}
	s.mu.Unlock()
	reply(w, s.newTask(r.PathValue("node"), "qmsnapshot", strconv.Itoa(id), 2*time.Second,
		[]string{"snapshotting 'drive-scsi0' (" + diskStore(r.PathValue("node")) + ":vm-" + strconv.Itoa(id) + "-disk-0)", "saving VM state and RAM"}, func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			parent := ""
			if n := len(s.snaps[id]); n > 0 {
				parent = s.snaps[id][n-1].name
			}
			s.snaps[id] = append(s.snaps[id], snap{name: name, desc: r.PostForm.Get("description"), parent: parent,
				time: time.Now().Unix(), ram: r.PostForm.Get("vmstate") == "1"})
		}))
}

func (s *Server) snapRollback(w http.ResponseWriter, r *http.Request) {
	reply(w, s.newTask(r.PathValue("node"), "qmrollback", r.PathValue("vmid"), 2*time.Second,
		[]string{"rolling back to snapshot '" + r.PathValue("snap") + "'"}, nil))
}

func (s *Server) snapDelete(w http.ResponseWriter, r *http.Request) {
	id, name := s.vmidOf(r), r.PathValue("snap")
	reply(w, s.newTask(r.PathValue("node"), "qmdelsnapshot", strconv.Itoa(id), 2*time.Second,
		[]string{"delete snapshot '" + name + "'"}, func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			list := s.snaps[id]
			i := slices.IndexFunc(list, func(x snap) bool { return x.name == name })
			if i < 0 {
				return
			}
			for j := range list {
				if list[j].parent == name {
					list[j].parent = list[i].parent
				}
			}
			s.snaps[id] = slices.Delete(list, i, i+1)
		}))
}

// ---------- clone / template / apagar ----------

func (s *Server) clone(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	f := r.PostForm
	newid, _ := strconv.Atoi(f.Get("newid"))
	if newid < 100 || s.hasGuest(newid) {
		fail(w, 500, fmt.Sprintf("VM %d already exists", newid))
		return
	}
	s.mu.Lock()
	src := s.guestByPath(r)
	s.mu.Unlock()
	if src == nil {
		fail(w, 500, "no such guest")
		return
	}
	node := src.node
	if t := f.Get("target"); t != "" {
		node = t
	}
	g := *src
	g.vmid, g.node, g.status, g.template = newid, node, "stopped", false
	g.name = f.Get("name") + f.Get("hostname")
	mode := "linked clone"
	if f.Get("full") == "1" {
		mode = "full clone"
	}
	reply(w, s.newTask(src.node, "qmclone", strconv.Itoa(src.vmid), 4*time.Second, []string{
		fmt.Sprintf("create %s of drive scsi0 (%s:vm-%d-disk-0)", mode, diskStore(src.node), src.vmid),
		"transferred 4.0 GiB of 32.0 GiB (12.50%)", "transferred 32.0 GiB of 32.0 GiB (100.00%)",
	}, func() { s.addGuest(&g) }))
}

func (s *Server) makeTemplate(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.guestByPath(r)
	if g == nil {
		fail(w, 500, "no such guest")
		return
	}
	if s.status[g.vmid] == "running" {
		fail(w, 500, "you can't convert a running VM to a template")
		return
	}
	g.template = true
	reply(w, nil)
}

func (s *Server) destroy(w http.ResponseWriter, r *http.Request) {
	id := s.vmidOf(r)
	s.mu.Lock()
	running := s.status[id] == "running"
	s.mu.Unlock()
	if running {
		fail(w, 500, "VM is running - destroy failed")
		return
	}
	reply(w, s.newTask(r.PathValue("node"), "qmdestroy", strconv.Itoa(id), 2*time.Second,
		[]string{fmt.Sprintf("Removing image: 100%% complete...done."), "purging VM " + strconv.Itoa(id) + " from related configurations.."}, func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.list = slices.DeleteFunc(s.list, func(g *guest) bool { return g.vmid == id })
			delete(s.status, id)
			delete(s.confs, id)
		}))
}

// ---------- console VNC falso ----------

func (s *Server) vncproxy(w http.ResponseWriter, r *http.Request) {
	reply(w, map[string]any{"port": 5900 + time.Now().Nanosecond()%100, "ticket": "PVEVNC:" + token(), "user": "root@pam",
		"cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
		"upid": s.newTask(r.PathValue("node"), "vncproxy", r.PathValue("vmid"), time.Hour, nil, nil)})
}

const fbW, fbH = 1024, 640

type pixfmt struct {
	rShift, gShift, bShift uint8
	bigEndian              bool
}

func (s *Server) vncSocket(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"binary"}, InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer c.CloseNow()
	name := "VM " + r.PathValue("vmid")
	s.mu.Lock()
	if g := s.guestByPath(r); g != nil {
		name = g.name
	}
	s.mu.Unlock()
	conn := websocket.NetConn(r.Context(), c, websocket.MessageBinary)
	defer conn.Close()
	rfb(conn, name)
}

// rfb fala o protocolo RFB 3.8 com autenticação VNC (aceita qualquer senha).
func rfb(conn io.ReadWriter, name string) {
	rd := bufio.NewReader(conn)
	wr := bufio.NewWriter(conn)
	flush := func() bool { return wr.Flush() == nil }
	be := binary.BigEndian

	wr.WriteString("RFB 003.008\n")
	if !flush() {
		return
	}
	ver := make([]byte, 12)
	if _, err := io.ReadFull(rd, ver); err != nil {
		return
	}
	wr.Write([]byte{1, 2}) // um tipo de segurança: VNC auth
	flush()
	if _, err := rd.ReadByte(); err != nil {
		return
	}
	wr.Write(make([]byte, 16)) // desafio
	flush()
	if _, err := io.ReadFull(rd, make([]byte, 16)); err != nil {
		return
	}
	binary.Write(wr, be, uint32(0)) // OK
	flush()
	if _, err := rd.ReadByte(); err != nil { // ClientInit
		return
	}
	pf := pixfmt{rShift: 16, gShift: 8, bShift: 0}
	binary.Write(wr, be, uint16(fbW))
	binary.Write(wr, be, uint16(fbH))
	wr.Write([]byte{32, 24, 0, 1})
	binary.Write(wr, be, [3]uint16{255, 255, 255})
	wr.Write([]byte{pf.rShift, pf.gShift, pf.bShift, 0, 0, 0})
	binary.Write(wr, be, uint32(len(name)))
	wr.WriteString(name)
	flush()

	sent := false
	for {
		t, err := rd.ReadByte()
		if err != nil {
			return
		}
		switch t {
		case 0: // SetPixelFormat
			b := make([]byte, 19)
			if _, err := io.ReadFull(rd, b); err != nil {
				return
			}
			pf = pixfmt{rShift: b[13], gShift: b[14], bShift: b[15], bigEndian: b[5] != 0}
		case 2: // SetEncodings
			b := make([]byte, 3)
			if _, err := io.ReadFull(rd, b); err != nil {
				return
			}
			n := int(be.Uint16(b[1:]))
			if _, err := io.ReadFull(rd, make([]byte, 4*n)); err != nil {
				return
			}
		case 3: // FramebufferUpdateRequest
			b := make([]byte, 9)
			if _, err := io.ReadFull(rd, b); err != nil {
				return
			}
			// Tela estática: manda uma vez (e de novo se pedirem completa).
			if b[0] == 0 || !sent {
				sendFrame(wr, pf, name)
				if !flush() {
					return
				}
				sent = true
			}
		case 4: // KeyEvent
			if _, err := io.ReadFull(rd, make([]byte, 7)); err != nil {
				return
			}
		case 5: // PointerEvent
			if _, err := io.ReadFull(rd, make([]byte, 5)); err != nil {
				return
			}
		case 6: // ClientCutText
			b := make([]byte, 7)
			if _, err := io.ReadFull(rd, b); err != nil {
				return
			}
			if _, err := io.ReadFull(rd, make([]byte, be.Uint32(b[3:]))); err != nil {
				return
			}
		default:
			return
		}
	}
}

// sendFrame desenha uma "área de trabalho": fundo, barra de tarefas e uma
// janela com linhas de texto em cinza.
func sendFrame(wr io.Writer, pf pixfmt, name string) {
	be := binary.BigEndian
	wr.Write([]byte{0, 0})
	binary.Write(wr, be, uint16(1))
	binary.Write(wr, be, [4]uint16{0, 0, fbW, fbH})
	binary.Write(wr, be, int32(0)) // raw
	px := make([]byte, 4)
	put := func(r, g, b uint8) {
		v := uint32(r)<<pf.rShift | uint32(g)<<pf.gShift | uint32(b)<<pf.bShift
		if pf.bigEndian {
			be.PutUint32(px, v)
		} else {
			binary.LittleEndian.PutUint32(px, v)
		}
		wr.Write(px)
	}
	seed := 0
	for _, ch := range name {
		seed += int(ch)
	}
	for y := 0; y < fbH; y++ {
		for x := 0; x < fbW; x++ {
			switch {
			case y >= fbH-36: // barra de tarefas
				if x > 10 && x < 34 && y > fbH-30 && y < fbH-6 {
					put(42, 60, 244)
				} else {
					put(24, 25, 28)
				}
			case x > 180 && x < 844 && y > 110 && y < 470: // janela
				switch {
				case y < 142:
					put(232, 233, 236)
				case (y-160)%28 < 10 && y > 160 && y < 440 && x > 210 && x < 210+((y*7+seed)%480)+60:
					put(196, 199, 205)
				default:
					put(255, 255, 255)
				}
			default: // fundo em degradê
				put(uint8(20+y*20/fbH), uint8(30+x*30/fbW), uint8(90+y*80/fbH))
			}
		}
	}
}
