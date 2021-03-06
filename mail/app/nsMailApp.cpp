/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#if defined(XP_OS2)
#define INCL_BASE
#define INCL_PM
#include <os2.h>
#endif

#include "nsXULAppAPI.h"
#include "mozilla/AppData.h"
#include "application.ini.h"
#include "nsXPCOMGlue.h"
#if defined(XP_WIN)
#include <windows.h>
#include <stdlib.h>
#elif defined(XP_OS2)
#include <time.h>
#include <unistd.h>
#elif defined(XP_UNIX)
#include <sys/time.h>
#include <sys/resource.h>
#include <unistd.h>
#endif

#ifdef XP_MACOSX
#include "MacQuirks.h"
#endif

#include <stdio.h>
#include <stdarg.h>

#include "nsCOMPtr.h"
#include "nsIFile.h"
#include "nsStringGlue.h"

#ifdef XP_WIN
// we want a wmain entry point
#include "nsWindowsWMain.cpp"
#define snprintf _snprintf
#define strcasecmp _stricmp
#endif
#include "BinaryPath.h"

#include "nsXPCOMPrivate.h" // for MAXPATHLEN and XPCOM_DLL

#include "mozilla/Telemetry.h"
#include "mozilla/WindowsDllBlocklist.h"

using namespace mozilla;

#ifdef XP_MACOSX
#define kOSXResourcesFolder "Resources"
#endif

static void Output(const char *fmt, ... )
{
  va_list ap;
  va_start(ap, fmt);

#ifndef XP_WIN
  vfprintf(stderr, fmt, ap);
#ifdef XP_OS2
  char msg[2048];
  // Put the message to the console...
  vsnprintf(msg, sizeof(msg), fmt, ap);
  // ...and to a message box
  HAB hab = WinInitialize(0);
  if (hab) {
    HMQ hmq = WinCreateMsgQueue(hab, 0);
    if (!hmq && ERRORIDERROR(WinGetLastError(hab)) == PMERR_NOT_IN_A_PM_SESSION) {
      // Morph from VIO to PM
      PPIB ppib;
      PTIB ptib;
      DosGetInfoBlocks(&ptib, &ppib);
      ppib->pib_ultype = 3;
      // Retry
      hmq = WinCreateMsgQueue(hab, 0);
    }
    if (hmq != NULLHANDLE) {
      WinMessageBox(HWND_DESKTOP, 0, msg, "Thunderbird", 0,
                    MB_OK | MB_ERROR | MB_MOVEABLE);
    }
  }
#endif
#else
  char msg[2048];
  vsnprintf_s(msg, _countof(msg), _TRUNCATE, fmt, ap);

  wchar_t wide_msg[2048];
  MultiByteToWideChar(CP_UTF8,
                      0,
                      msg,
                      -1,
                      wide_msg,
                      _countof(wide_msg));
#if MOZ_WINCONSOLE
  fwprintf_s(stderr, wide_msg);
#else
  // Linking user32 at load-time interferes with the DLL blocklist (bug 932100).
  // This is a rare codepath, so we can load user32 at run-time instead.
  HMODULE user32 = LoadLibraryW(L"user32.dll");
  if (user32) {
    typedef int (WINAPI * MessageBoxWFn)(HWND, LPCWSTR, LPCWSTR, UINT);
    MessageBoxWFn messageBoxW = (MessageBoxWFn)GetProcAddress(user32, "MessageBoxW");
    if (messageBoxW) {
      messageBoxW(nullptr, wide_msg, L"Thunderbird", MB_OK
                                                   | MB_ICONERROR
                                                   | MB_SETFOREGROUND);
    }
    FreeLibrary(user32);
  }
#endif
#endif

  va_end(ap);
}

/**
 * Return true if |arg| matches the given argument name.
 */
static bool IsArg(const char* arg, const char* s)
{
  if (*arg == '-')
  {
    if (*++arg == '-')
      ++arg;
    return !strcasecmp(arg, s);
  }

#if defined(XP_WIN)
  if (*arg == '/')
    return !strcasecmp(++arg, s);
#endif

  return false;
}

XRE_GetFileFromPathType XRE_GetFileFromPath;
XRE_CreateAppDataType XRE_CreateAppData;
XRE_FreeAppDataType XRE_FreeAppData;
XRE_TelemetryAccumulateType XRE_TelemetryAccumulate;
XRE_mainType XRE_main;

static const nsDynamicFunctionLoad kXULFuncs[] = {
    { "XRE_GetFileFromPath", (NSFuncPtr*) &XRE_GetFileFromPath },
    { "XRE_CreateAppData", (NSFuncPtr*) &XRE_CreateAppData },
    { "XRE_FreeAppData", (NSFuncPtr*) &XRE_FreeAppData },
    { "XRE_TelemetryAccumulate", (NSFuncPtr*) &XRE_TelemetryAccumulate },
    { "XRE_main", (NSFuncPtr*) &XRE_main },
    { nullptr, nullptr }
};

static int do_main(int argc, char* argv[], nsIFile *xreDirectory, bool greIsXre)
{
  NS_LogInit();

  nsCOMPtr<nsIFile> appini;
  nsresult rv;
  uint32_t mainFlags = 0;

  // Allow firefox.exe to launch XULRunner apps via -app <application.ini>
  // Note that -app must be the *first* argument.
  const char *appDataFile = getenv("XUL_APP_FILE");
  if (appDataFile && *appDataFile) {
    rv = XRE_GetFileFromPath(appDataFile, getter_AddRefs(appini));
    if (NS_FAILED(rv)) {
      Output("Invalid path found: '%s'", appDataFile);
      return 255;
    }
  }
  else if (argc > 1 && IsArg(argv[1], "app")) {
    if (argc == 2) {
      Output("Incorrect number of arguments passed to -app");
      return 255;
    }

    rv = XRE_GetFileFromPath(argv[2], getter_AddRefs(appini));
    if (NS_FAILED(rv)) {
      Output("application.ini path not recognized: '%s'", argv[2]);
      return 255;
    }

    char appEnv[MAXPATHLEN];
    snprintf(appEnv, MAXPATHLEN, "XUL_APP_FILE=%s", argv[2]);
    if (putenv(appEnv)) {
      Output("Couldn't set %s.\n", appEnv);
      return 255;
    }
    argv[2] = argv[0];
    argv += 2;
    argc -= 2;
  }

  int result;
  if (appini) {
    nsXREAppData *appData;
    rv = XRE_CreateAppData(appini, &appData);
    if (NS_FAILED(rv)) {
      Output("Couldn't read application.ini");
      return 255;
    }
    // xreDirectory already has a refcount from NS_NewLocalFile
    appData->xreDirectory = xreDirectory;
    result = XRE_main(argc, argv, appData, 0);
    XRE_FreeAppData(appData);
  } else {
    ScopedAppData appData(&sAppData);
    nsCOMPtr<nsIFile> exeFile;
    rv = mozilla::BinaryPath::GetFile(argv[0], getter_AddRefs(exeFile));
    if (NS_FAILED(rv)) {
      Output("Couldn't find the application directory.\n");
      return 255;
    }

    nsCOMPtr<nsIFile> greDir;
  if (greIsXre) {
    greDir = xreDirectory;
  } else {
    exeFile->GetParent(getter_AddRefs(greDir));
#ifdef XP_MACOSX
    greDir->SetNativeLeafName(NS_LITERAL_CSTRING(kOSXResourcesFolder));
#endif
    }
    SetStrongPtr(appData.directory, static_cast<nsIFile*>(greDir.get()));
    // xreDirectory already has a refcount from NS_NewLocalFile
    appData.xreDirectory = xreDirectory;

    result = XRE_main(argc, argv, &appData, mainFlags);
  }
  return result;
}

static bool
FileExists(const char *path)
{
#ifdef XP_WIN
  wchar_t wideDir[MAX_PATH];
  MultiByteToWideChar(CP_UTF8, 0, path, -1, wideDir, MAX_PATH);
  DWORD fileAttrs = GetFileAttributesW(wideDir);
  return fileAttrs != INVALID_FILE_ATTRIBUTES;
#else
  return access(path, R_OK) == 0;
#endif
}

static nsresult
InitXPCOMGlue(const char *argv0, nsIFile **xreDirectory, bool *greIsXre)
{
  char exePath[MAXPATHLEN];

  *greIsXre = false;

  nsresult rv = mozilla::BinaryPath::Get(argv0, exePath);
  if (NS_FAILED(rv)) {
    Output("Couldn't find the application directory.\n");
    return rv;
  }

  char *lastSlash = strrchr(exePath, XPCOM_FILE_PATH_SEPARATOR[0]);
  if (!lastSlash || (size_t(lastSlash - exePath) > MAXPATHLEN - sizeof(XPCOM_DLL)))
    return NS_ERROR_FAILURE;

  strcpy(lastSlash + 1, XPCOM_DLL);

  if (!FileExists(exePath)) {
#ifdef XP_OS2
    // If no runtime exists in the launcher's directory, we check if it is
    // usr/bin (e.g. an RPM installation) and search for the runtime in
    // usr/lib/Thunderbird-XYZ.
    bool ok = false;
    const char UsrBin[] = "\\usr\\bin";
    const char ThunderbirdXYZ[] = "lib\\Thunderbird-" MOZ_APP_UA_VERSION;
    size_t len = lastSlash - exePath;
    if (MAXPATHLEN - len - sizeof(XPCOM_DLL) >= sizeof(ThunderbirdXYZ) - 4 /* lib\\ */) {
      if (len > sizeof(UsrBin) - 1 /* \0 */ &&
          !strnicmp(lastSlash - sizeof(UsrBin) + 1, UsrBin, sizeof(UsrBin) - 1)) {
        memcpy(lastSlash - 3 /* bin */, ThunderbirdXYZ, sizeof(ThunderbirdXYZ) - 1);
        lastSlash += -3 + sizeof(ThunderbirdXYZ) - 1;
        *lastSlash = XPCOM_FILE_PATH_SEPARATOR[0];
        strcpy(lastSlash + 1, XPCOM_DLL);
        ok = FileExists(exePath);
        if (ok) {
          // In this setup, application data is expected to reside in a dir
          // where XUL.DLL resides rather than in the launcher's dir by default.
          *greIsXre = true;
        }
      }
    }
    if (!ok)
#endif
    {
      Output("Could not find the Mozilla runtime (%s).\n", XPCOM_DLL);
      return NS_ERROR_FAILURE;
    }
  }

#ifdef XP_OS2
  // Set BEGINLIBPATH/LIBPATHSTRICT to load private versions of XUL.DLL and
  // support libraries instead of the ones from a common LIBPATH and other
  // running processes.
  {
    const char BeginLibPathVar[] = ";%BEGINLIBPATH%";
    char buf[MAXPATHLEN + sizeof(BeginLibPathVar)];
    APIRET arc;
    memcpy(buf, exePath, lastSlash - exePath);
    strcpy(buf + (lastSlash - exePath), BeginLibPathVar);
    arc = DosSetExtLIBPATH(buf, BEGIN_LIBPATH);
    if (!arc)
      arc = DosSetExtLIBPATH("T", LIBPATHSTRICT);
    if (arc) {
      Output("Could not setup environment for the Mozilla runtime (DOS error %lu).\n", arc);
      return NS_ERROR_FAILURE;
    }
  }
#endif

  // We do this because of data in bug 771745
  XPCOMGlueEnablePreload();

  rv = XPCOMGlueStartup(exePath);
  if (NS_FAILED(rv)) {
    Output("Couldn't load XPCOM.\n");
    return rv;
  }

  rv = XPCOMGlueLoadXULFunctions(kXULFuncs);
  if (NS_FAILED(rv)) {
    Output("Couldn't load XRE functions.\n");
    return rv;
  }

  NS_LogInit();

  // chop XPCOM_DLL off exePath
  *lastSlash = '\0';
#ifdef XP_MACOSX
  lastSlash = strrchr(exePath, XPCOM_FILE_PATH_SEPARATOR[0]);
  strcpy(lastSlash + 1, kOSXResourcesFolder);
#endif
#ifdef XP_WIN
  rv = NS_NewLocalFile(NS_ConvertUTF8toUTF16(exePath), false,
                       xreDirectory);
#else
  rv = NS_NewNativeLocalFile(nsDependentCString(exePath), false,
                             xreDirectory);
#endif

  return rv;
}

int main(int argc, char* argv[])
{
#ifdef XP_MACOSX
  TriggerQuirks();
#endif

  int gotCounters;
#if defined(XP_UNIX)
  struct rusage initialRUsage;
  gotCounters = !getrusage(RUSAGE_SELF, &initialRUsage);
#elif defined(XP_WIN)
  // GetProcessIoCounters().ReadOperationCount seems to have little to
  // do with actual read operations. It reports 0 or 1 at this stage
  // in the program. Luckily 1 coincides with when prefetch is
  // enabled. If Windows prefetch didn't happen we can do our own
  // faster dll preloading.
  IO_COUNTERS ioCounters;
  gotCounters = GetProcessIoCounters(GetCurrentProcess(), &ioCounters);
#elif defined(XP_OS2)
  // no counters at the moment
  gotCounters = 0;
#endif

  nsIFile *xreDirectory;

#ifdef HAS_DLL_BLOCKLIST
  DllBlocklist_Initialize();

#ifdef DEBUG
  // In order to be effective against AppInit DLLs, the blocklist must be
  // initialized before user32.dll is loaded into the process (bug 932100).
  if (GetModuleHandleA("user32.dll")) {
    fprintf(stderr, "DLL blocklist was unable to intercept AppInit DLLs.\n");
  }
#endif
#endif

  bool greIsXre;
  nsresult rv = InitXPCOMGlue(argv[0], &xreDirectory, &greIsXre);
  if (NS_FAILED(rv)) {
    return 255;
  }

  if (gotCounters) {
#if defined(XP_WIN)
    XRE_TelemetryAccumulate(mozilla::Telemetry::EARLY_GLUESTARTUP_READ_OPS,
                            int(ioCounters.ReadOperationCount));
    XRE_TelemetryAccumulate(mozilla::Telemetry::EARLY_GLUESTARTUP_READ_TRANSFER,
                            int(ioCounters.ReadTransferCount / 1024));
    IO_COUNTERS newIoCounters;
    if (GetProcessIoCounters(GetCurrentProcess(), &newIoCounters)) {
      XRE_TelemetryAccumulate(mozilla::Telemetry::GLUESTARTUP_READ_OPS,
                              int(newIoCounters.ReadOperationCount - ioCounters.ReadOperationCount));
      XRE_TelemetryAccumulate(mozilla::Telemetry::GLUESTARTUP_READ_TRANSFER,
                              int((newIoCounters.ReadTransferCount - ioCounters.ReadTransferCount) / 1024));
    }
#elif defined(XP_UNIX)
    XRE_TelemetryAccumulate(mozilla::Telemetry::EARLY_GLUESTARTUP_HARD_FAULTS,
                            int(initialRUsage.ru_majflt));
    struct rusage newRUsage;
    if (!getrusage(RUSAGE_SELF, &newRUsage)) {
      XRE_TelemetryAccumulate(mozilla::Telemetry::GLUESTARTUP_HARD_FAULTS,
                              int(newRUsage.ru_majflt - initialRUsage.ru_majflt));
    }
#endif
  }

  int result = do_main(argc, argv, xreDirectory, greIsXre);

  NS_LogTerm();

  return result;
}
