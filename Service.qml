import QtQuick
import Quickshell
import Quickshell.Io

// X Files background service: runs the poller CLI on the house cadence so
// the reply queue and spend meter stay current even when the panel is closed.
// All network, credential, classification, and state logic lives in
// bin/x-files-poll; this file is a timer with a Process. The poll is a
// no-op (writes an unconfigured state and exits) until the user has run
// x-files-login, and it stops fetching entirely once the monthly spend
// cap is reached.
Item {
  id: root

  property var shell: null
  property var manifest: null

  readonly property string pollerPath:
    Qt.resolvedUrl("bin/x-files-poll").toString().replace(/^file:\/\//, "")

  // 15 minutes. Reply waves build over minutes-to-hours, not seconds, and
  // since_id discipline means a quiet interval polls (almost) free; polling
  // harder just spends credits faster for no fresher a queue.
  readonly property int pollIntervalSec: 900

  function pollNow() {
    if (pollProc.running) return
    pollProc.command = [root.pollerPath]
    pollProc.running = true
  }

  Process {
    id: pollProc
  }

  Timer {
    interval: root.pollIntervalSec * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.pollNow()
  }
}
