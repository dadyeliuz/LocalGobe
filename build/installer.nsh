; LocalGobe Smart Windows Setup & Update Hook
; Provides:
;   - Version detection via Windows uninstall registry
;   - In-place update prompt for older versions
;   - Repair prompt for identical versions
;   - Downgrade blocking for newer installed versions
;   - Strict user data preservation (%LOCALAPPDATA%\LocalGobe\data untouched)

!include "LogicLib.nsh"
!include "WordFunc.nsh"

!ifndef BUILD_UNINSTALLER
  !ifndef LOCALGOBE_INSTALLER_VARS_DEFINED
    !define LOCALGOBE_INSTALLER_VARS_DEFINED
    Var /GLOBAL lgInstalledVersion
    Var /GLOBAL lgInstalledNorm
    Var /GLOBAL lgSetupNorm
    Var /GLOBAL lgCompResult
  !endif

  Function LocalGobe_NormalizeVersion
    Exch $R0 ; input version
    Push $R1
    Push $R2

    ${WordFind} "$R0" "-preview." "E+1{" $R1
    IfErrors not_preview is_preview

    is_preview:
      ${WordFind} "$R0" "-preview." "E+1}" $R2
      StrCpy $R0 "$R1.0.$R2"
      Goto done

    not_preview:
      StrCpy $R0 "$R0.1.0"

    done:
      Pop $R2
      Pop $R1
      Exch $R0
  FunctionEnd

  !macro customInit
    # Read existing installed version from registry
    # Check SHELL_CONTEXT first, then fallback to HKCU and HKLM
    ReadRegStr $lgInstalledVersion SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    ${if} $lgInstalledVersion == ""
      ReadRegStr $lgInstalledVersion HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    ${endif}
    ${if} $lgInstalledVersion == ""
      ReadRegStr $lgInstalledVersion HKLM "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    ${endif}

    # If no existing version found, this is a fresh install -> proceed normally
    ${if} $lgInstalledVersion != ""
      # Compare installed version with setup version (${VERSION})
      Push $lgInstalledVersion
      Call LocalGobe_NormalizeVersion
      Pop $lgInstalledNorm

      Push "${VERSION}"
      Call LocalGobe_NormalizeVersion
      Pop $lgSetupNorm

      ${VersionCompare} "$lgInstalledNorm" "$lgSetupNorm" $lgCompResult

      # $lgCompResult:
      # 0 = same version (Repair)
      # 1 = installed is newer than setup (Downgrade Blocked)
      # 2 = installed is older than setup (Update)

      ${if} $lgCompResult == 1
        # NEWER INSTALLED + OLDER SETUP -> DOWNGRADE BLOCKED
        ${ifNot} ${Silent}
          MessageBox MB_OK|MB_ICONINFORMATION "במחשב מותקנת גרסה חדשה יותר של LocalGobe.$\r$\n$\r$\nאין צורך להתקין גרסה ישנה יותר." /SD IDOK
        ${endif}
        Quit
      ${elseif} $lgCompResult == 0
        # SAME VERSION + SAME SETUP -> REPAIR
        ${ifNot} ${Silent}
          MessageBox MB_OKCANCEL|MB_ICONQUESTION "LocalGobe כבר מותקנת בגרסה הזו.$\r$\n$\r$\nהאם לתקן את ההתקנה?" /SD IDOK IDOK doRepair
          Quit
          doRepair:
        ${endif}
      ${elseif} $lgCompResult == 2
        # OLDER INSTALLED + NEWER SETUP -> UPDATE
        ${ifNot} ${Silent}
          MessageBox MB_OKCANCEL|MB_ICONQUESTION "LocalGobe $lgInstalledVersion כבר מותקנת.$\r$\n$\r$\nלעדכן לגרסה ${VERSION}?" /SD IDOK IDOK doUpdate
          Quit
          doUpdate:
        ${endif}
      ${endif}
    ${endif}
  !macroend
!endif
