// Package web embeds the built panel (web/static, from `npm run build`) into the
// hub binary, so the image ships one file and no Node runtime.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:static
var static embed.FS

func FS() fs.FS {
	sub, err := fs.Sub(static, "static")
	if err != nil {
		panic(err)
	}
	return sub
}
