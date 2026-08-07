; Hooked into the generated NSIS uninstaller via bundle.nsis.include.
;
; The bundled server treats server-dist as its project root (detectProjectDir
; finds the package.json there), so it creates runtime directories on first
; run — server-dist/data (SQLite, logs, attachments), runtime-artifacts, ...
; The auto-generated uninstall script only knows the dirs it created at
; install time and removes them with non-recursive RMDir, so these runtime
; dirs are left behind as empty shells under sidecar\server-dist.
;
; By the time NSIS_HOOK_POSTUNINSTALL runs, CheckIfAppIsRunning has killed
; the shell and the kill-on-close job object has reaped the sidecar, so
; nothing holds the tree — remove the whole sidecar dir recursively for a
; fully clean uninstall.
!macro NSIS_HOOK_POSTUNINSTALL
  RMDir /r "$INSTDIR\sidecar"
  RMDir "$INSTDIR"
!macroend
