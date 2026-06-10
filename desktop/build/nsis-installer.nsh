; ------------------------------------------------------------------
; OhMyAgent NSIS Installer Customization
; Included by electron-builder via nsis.include in electron-builder.yml
; ------------------------------------------------------------------

; --- Install hooks ---
!macro customInstall
  ; Create data directory skeleton in user's AppData
  DetailPrint "Setting up OhMyAgent data directories..."

  ; Ensure per-user data directories exist
  CreateDirectory "$APPDATA\OhMyAgent\data"
  CreateDirectory "$APPDATA\OhMyAgent\logs"

  ; Check if config.yaml already exists
  IfFileExists "$APPDATA\OhMyAgent\config.yaml" configExists noConfig
  noConfig:
    DetailPrint "First install -- no existing config.yaml found."
  configExists:
    DetailPrint "OhMyAgent setup complete."
!macroend

; --- Uninstall hooks ---
!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Do you want to keep your OhMyAgent user data?$\n$\n(config.yaml, database, logs at $APPDATA\OhMyAgent)" \
    IDYES keepData IDNO deleteData

  keepData:
    DetailPrint "Keeping user data at $APPDATA\OhMyAgent"
    Goto done

  deleteData:
    DetailPrint "Removing user data..."
    RMDir /r "$APPDATA\OhMyAgent"
    Goto done

  done:
!macroend

; --- customInit (runs before install) ---
!macro customInit
  ; Optional: check for running instance using FindWindow
  FindWindow $0 "" "OhMyAgent" 0
  StrCmp $0 0 notRunning
  MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
    "OhMyAgent appears to be running. Please close it before continuing." \
    IDOK tryClose
  Abort
  tryClose:
    ; Attempt graceful close via SendMessage
    SendMessage $0 ${WM_CLOSE} 0 0
    Sleep 2000
  notRunning:
!macroend
