#ifndef AppVersion
  #error AppVersion must be supplied with /DAppVersion=...
#endif
#ifndef StageDir
  #error StageDir must be supplied with /DStageDir=...
#endif
#ifndef OutputDir
  #define OutputDir "output"
#endif
#ifndef WebView2Installer
  #error WebView2Installer must be supplied with /DWebView2Installer=...
#endif
#ifndef VCRedistInstaller
  #error VCRedistInstaller must be supplied with /DVCRedistInstaller=...
#endif

[Setup]
AppId={{A7D2B4F0-4DF8-4B27-A8D7-7F6C5F9F1A01}
AppName=Plectrify
AppVersion={#AppVersion}
AppVerName=Plectrify {#AppVersion}
AppPublisher=Plectrify contributors
AppPublisherURL=https://github.com/patrickiel/plectrify
AppSupportURL=https://github.com/patrickiel/plectrify/issues
DefaultDirName={autopf}\Plectrify
DefaultGroupName=Plectrify
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
OutputDir={#OutputDir}
OutputBaseFilename=Plectrify-win-x64-setup
UninstallDisplayIcon={app}\Plectrify.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ChangesAssociations=no
; Signing is intentionally disabled for the first release. A future release
; can add SignTool directives without changing the payload layout.

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
; The tasks page is where the network notice lives: SignPath's terms (see
; issue #46) ask for unbidden network use to be stated during installation
; with a way to turn it off, and these two checkboxes are that way. Keep this
; text in step with site/src/routes/docs/privacy/+page.md.
SelectTasksLabel2=Select the additional tasks you would like Setup to perform while installing [name], then click Next.%n%nPlectrify collects no personal data and sends no telemetry. The two Internet options below are the only requests it makes without being asked, besides loading its signed plugin catalogue from cdn.plectrify.com. Installing packages and TONE3000 happen only when you ask. Details: plectrify.com/docs/privacy

[Tasks]
; Checked by default: the plugin is inert in Common Files until a DAW scans
; it, and a checkbox nobody notices is how a feature stays undiscovered. A
; standalone-only user unchecks it here.
Name: "vst3"; Description: "Install the Plectrify VST3 plug-in (run the same rig inside your DAW)"
; The app's unbidden network use, each with its off switch. Neither does
; anything here: the choices are written to installer-options.json (see
; WriteInstallerOptions) and read by the app, and only where the user's own
; settings have not answered — Settings → Updates overrides the first later.
Name: "updatecheck"; Description: "Check GitHub for new versions when Plectrify starts"; GroupDescription: "Internet access:"
Name: "starterplugins"; Description: "Download a few free starter plugins on first launch"; GroupDescription: "Internet access:"

[InstallDelete]
; Vite filenames are content-hashed, so an upgrade must replace the UI tree
; instead of merging the new payload with assets left by an older release.
Type: filesandordirs; Name: "{app}\ui"
; Same reasoning for the shipped plugins: a bundle is a folder of many files,
; and a new version's must replace the old one rather than be merged into it.
Type: filesandordirs; Name: "{app}\plugins"
; Deliberately NOT gated on the vst3 task: the app and the plugin share one
; engine and its session/state formats, so a version-skewed pair must be
; unrepresentable — every install either replaces the bundle (task checked) or
; removes it (task unchecked). Unchecking on an upgrade therefore uninstalls
; the plugin rather than leaving last release's copy behind.
Type: filesandordirs; Name: "{commoncf64}\VST3\Plectrify.vst3"

[Files]
Source: "{#StageDir}\Plectrify.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\ui\*"; DestDir: "{app}\ui"; Flags: ignoreversion recursesubdirs createallsubdirs
; The plugins Plectrify ships, as opposed to the ones it offers. These are part
; of the application: inside {app}, on the app's own scan path, never listed by
; the Packages panel, and removed with it. Neural Amp Modeler is here because
; every TONE3000 tone is a capture that loads into it.
Source: "{#StageDir}\plugins\*"; DestDir: "{app}\plugins"; Flags: ignoreversion recursesubdirs createallsubdirs
; Plectrify itself as a VST3, for DAWs. Self-contained: the bundle carries its
; own ui/ and plugins/ under Contents/Resources (see moduleResourceDir() in
; Source/app/AppPaths.h), because a Release binary has no source-tree fallback
; and must not depend on {app} existing. {commoncf64}\VST3 is the standard
; machine-wide VST3 folder every host scans; PrivilegesRequired=admin already
; covers writing it.
Source: "{#StageDir}\vst3\Plectrify.vst3\*"; DestDir: "{commoncf64}\VST3\Plectrify.vst3"; Flags: ignoreversion recursesubdirs createallsubdirs; Tasks: vst3
Source: "{#StageDir}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\JUCE_LICENSE.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\THIRD_PARTY_NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\SOURCE_OFFER.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\BUILD_INFO.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#WebView2Installer}"; DestDir: "{tmp}"; Flags: deleteafterinstall ignoreversion
Source: "{#VCRedistInstaller}"; DestDir: "{tmp}"; Flags: deleteafterinstall ignoreversion

[Icons]
Name: "{group}\Plectrify"; Filename: "{app}\Plectrify.exe"

[Run]
; Only when the runtime is not there yet (see WebView2RuntimeInstalled). The
; bootstrapper is the evergreen one: even with the runtime installed it goes
; to Microsoft's update service before it decides there is nothing to do,
; which on an update took longer than copying the files — all of it behind a
; progress bar Inno has already filled, since [Run] comes after the files.
; Microsoft's own guidance is to check the registry before running it. The
; VC++ redistributable is not gated: its installer exits at once when the
; installed copy is current, and the key it leaves has no reliable floor to
; compare the bundled version against.
Filename: "{tmp}\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; Parameters: "/silent /install"; StatusMsg: "Installing Microsoft WebView2 Runtime..."; Flags: waituntilterminated; Check: not WebView2RuntimeInstalled
Filename: "{tmp}\VC_redist.x64.exe"; Parameters: "/install /quiet /norestart"; StatusMsg: "Installing Microsoft Visual C++ Runtime..."; Flags: waituntilterminated
Filename: "{app}\Plectrify.exe"; Description: "Launch Plectrify"; Flags: nowait postinstall skipifsilent
; The in-app update's relaunch (see [Code]). The entry above never fires under
; /SILENT, and the app that started this Setup has quit by now, so this is the
; only way the player gets Plectrify back. runasoriginaluser is what the
; postinstall entry gets by default and this one must ask for: Setup is
; elevated, and an elevated Plectrify would run WebView2 as administrator and
; own every file it writes into the profile. Keyed on the parameter rather
; than on WizardSilent, so a silent deployment nobody is sitting at does not
; launch the app. RestartApplications cannot do this — it relaunches only
; programs that registered with Restart Manager, which JUCE does not.
Filename: "{app}\Plectrify.exe"; Flags: nowait runasoriginaluser; Check: LaunchedByApp

[UninstallDelete]
; User data intentionally lives outside {app} and is preserved on uninstall.
; That now includes catalogue plugins in {commonappdata}\Plectrify\plugins:
; they are the user's own plugins, installed at their request and usable by
; other hosts, so uninstalling Plectrify must not take them away. Deleting the
; folder by hand removes them.
Type: filesandordirs; Name: "{app}\ui"
; Ours, unlike {commonappdata}\Plectrify\plugins above: shipped with the app,
; never the user's own install, so it goes when the app goes.
Type: filesandordirs; Name: "{app}\plugins"
; The Plectrify VST3 is ours by the same rule — installed by this setup, never
; the user's own build — so it goes with the app. Only the bundle: the shared
; {commoncf64}\VST3 folder belongs to every vendor on the machine.
Type: filesandordirs; Name: "{commoncf64}\VST3\Plectrify.vst3"
; The installer's own answer file, not the user's data.
Type: files; Name: "{commonappdata}\Plectrify\installer-options.json"

[Code]
{ The in-app update (Source/update/UpdateInstaller.h). Plectrify downloads this
  Setup, verifies it and runs it with /SILENT and /PLECTRIFYRELAUNCH=1, and the
  two halves of the handshake live here.

  First, Setup says when it is through the UAC prompt. Setup.exe runs
  as-invoker and re-spawns itself elevated, so the prompt is Setup's own and the
  app cannot see it being declined — a declined prompt is exit code 2 and
  nothing on screen. InitializeSetup runs only in the elevated child, so a mutex
  created here is the app's signal that the installation is actually going to
  happen and it may quit. Inno's CreateMutex uses a null DACL, which is what
  lets the non-elevated app open it.

  Second, Setup waits for the app to be gone before it touches a file. JUCE's
  single-instance lock is a named mutex held for the app's lifetime and
  released only after its last write (audio_settings.xml, window.json), which
  is exactly when the files may be replaced. CheckForMutexes opens each name as
  given, so both the Global and the session-local spelling JUCE may have ended
  up with are named. A standard user elevating with another account's password
  cannot open the user's mutex, so there the wait falls through at once and
  Setup's ordinary file-in-use handling is the fallback.

  An ordinary interactive install — no parameter — does none of this. }

{ The tasks page's network choices, for the app to read at boot
  (PlectrifyEngine::readInstallerDefaults, then ui/.../installerDefaults.ts).
  In the content root because that is machine-wide like this install, and the
  one folder outside the user's profile the app already reads. Rewritten by
  every install, the in-app update's /SILENT one included — that run keeps the
  previous answers (UsePreviousTasks). }
procedure WriteInstallerOptions;
var
  Dir, Json: String;
begin
  Dir := ExpandConstant('{commonappdata}\Plectrify');
  ForceDirectories(Dir);
  Json := '{"checkForUpdates": ';
  if WizardIsTaskSelected('updatecheck') then Json := Json + 'true' else Json := Json + 'false';
  Json := Json + ', "starterInstall": ';
  if WizardIsTaskSelected('starterplugins') then Json := Json + 'true' else Json := Json + 'false';
  Json := Json + '}';
  SaveStringToFile(Dir + '\installer-options.json', Json, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    WriteInstallerOptions;
end;

function LaunchedByApp: Boolean;
begin
  Result := ExpandConstant('{param:PLECTRIFYRELAUNCH|0}') = '1';
end;

{ Whether the WebView2 Runtime is installed, read the way Microsoft documents
  it: the Edge Update client key, per machine (in the 32-bit view, on every
  Windows) or per user, holding a version in `pv` other than 0.0.0.0. The
  evergreen runtime keeps itself current, so any installed version will do. }
function WebView2RuntimeInstalled: Boolean;
var
  Version: String;
begin
  Result := False;
  if RegQueryStringValue(HKLM32, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version)
     or RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) then
    Result := (Version <> '') and (Version <> '0.0.0.0');
end;

function InitializeSetup: Boolean;
var
  Waited: Integer;
begin
  Result := True;
  if not LaunchedByApp then
    Exit;

  CreateMutex('Global\PlectrifyUpdateInProgress');

  { Up to a minute: a quit is a second or two, and a plugin editor that will
    not close is the only thing that makes it longer. Past that, racing the
    exit would end on Inno's file-in-use box with the app already half gone,
    so say what is happening and stop instead. }
  Waited := 0;
  while CheckForMutexes('Global\juceAppLock_Plectrify,Local\juceAppLock_Plectrify') and (Waited < 600) do
  begin
    Sleep(100);
    Waited := Waited + 1;
  end;

  if CheckForMutexes('Global\juceAppLock_Plectrify,Local\juceAppLock_Plectrify') then
  begin
    SuppressibleMsgBox('Plectrify is still running. Close it, then run the update again.', mbError, MB_OK, IDOK);
    Result := False;
  end;
end;
