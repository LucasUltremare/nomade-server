// Package web embute o build do frontend (web/dist) no binário.
package web

import "embed"

//go:embed all:dist
var Dist embed.FS
