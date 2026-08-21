import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// X Files panel: renders the reply store the Service owns and drives the
// needs-your-reply queue with Herald-standard keys. This file never touches
// the network and never sees the API token. There is NO node on a stock
// Omarchy install, so the whole plugin runs on Quickshell plus curl:
// Service.qml fetches, scores, and persists; the panel calls straight into
// it, so marking a reply done takes effect immediately.
Panel {
  id: root
  moduleName: "io.github.jeremylongshore.x-files"
  ipcTarget: "io.github.jeremylongshore.x-files"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  // Resolved by the BarWidget host. Everything degrades to an empty view when
  // it is missing rather than erroring.
  property var service: null

  property double nowMs: Date.now()

  // Bumped by the service on every store change so the computed views below
  // re-evaluate (a JS array mutated in place does not notify QML on its own).
  property int revision: 0

  Connections {
    target: root.service
    ignoreUnknownSignals: true
    function onStateChanged() { root.revision++ }
  }

  readonly property var queue: {
    root.revision
    return root.service ? root.service.queue : []
  }

  readonly property var posts: {
    root.revision
    return root.service ? root.service.posts : []
  }

  readonly property bool configured: {
    root.revision
    return root.service ? root.service.configured : false
  }

  readonly property bool stopped: {
    root.revision
    return root.service ? root.service.stopped : false
  }

  readonly property var ledger: {
    root.revision
    return root.service ? root.service.internal.ledger : { month: "", posts: 0, dollars: 0 }
  }

  readonly property real capUsd: {
    root.revision
    return root.service ? root.service.monthlyCapUsd : Model.DEFAULT_MONTHLY_CAP_USD
  }

  readonly property string spendMeter: {
    root.revision
    return root.service ? root.service.spendMeterMode : "Compact"
  }

  readonly property string accountUsername: {
    root.revision
    return root.service ? root.service.username : ""
  }

  readonly property string accountLast4: {
    root.revision
    return root.service ? String(root.service.bearerToken).slice(-4) : ""
  }

  readonly property var openQueue: {
    var out = []
    for (var i = 0; i < queue.length; i++) if (!queue[i].done) out.push(queue[i])
    return out
  }

  readonly property var pillState: {
    return {
      valid: true,
      configured: root.configured,
      stopped: root.stopped,
      queue: root.queue,
      ledger: root.ledger,
      account: { username: root.accountUsername, last4: root.accountLast4 }
    }
  }

  readonly property bool isAlert: stopped || openQueue.length > 0
  readonly property string label: Model.pillText(pillState)
  readonly property string tooltip: Model.tooltipText(pillState, nowMs)

  // The cursor tracks the reply's ID, not a raw index: a background poll can
  // insert a newer reply at the top of the newest-first queue, which would
  // shift every index, so an index cursor would silently point at a different
  // reply than the one the user is looking at.
  property string selectedId: ""

  readonly property int selIdx: {
    for (var i = 0; i < openQueue.length; i++) if (openQueue[i].id === selectedId) return i
    return openQueue.length > 0 ? 0 : -1
  }

  onOpenQueueChanged: {
    var found = false
    for (var i = 0; i < openQueue.length; i++) if (openQueue[i].id === selectedId) { found = true; break }
    if (!found) selectedId = openQueue.length > 0 ? openQueue[0].id : ""
  }

  function moveCursor(dy) {
    if (openQueue.length === 0) return
    var cur = selIdx < 0 ? 0 : selIdx
    var next = cur + dy
    if (next < 0) next = 0
    if (next >= openQueue.length) next = openQueue.length - 1
    selectedId = openQueue[next].id
  }

  function selectedItem() {
    for (var i = 0; i < openQueue.length; i++) if (openQueue[i].id === selectedId) return openQueue[i]
    return openQueue.length > 0 ? openQueue[0] : null
  }

  function openSelected() {
    var it = selectedItem()
    if (!it) return
    if (it.url !== "" && /^https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/[0-9]+$/.test(it.url)) {
      if (!openProc.running) {
        openProc.command = ["xdg-open", it.url]
        openProc.running = true
      }
    }
    if (root.service) root.service.markDone([it.id])
  }

  function markSelectedDone() {
    var it = selectedItem()
    if (it && root.service) root.service.markDone([it.id])
  }

  function markAllDone() {
    if (root.service) root.service.markAllDone()
  }

  function refresh() {
    nowMs = Date.now()
    if (root.service) root.service.poll()
  }

  function open() { root.controller.show() }
  function openFromHotkey() { root.controller.show() }
  function close() { root.controller.hide() }
  function toggle() { if (root.opened) root.close(); else root.openFromHotkey() }

  property bool popoutSwitchClosing: false
  function closeForPopoutSwitch() { root.close() }
  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  Process { id: openProc }

  Timer {
    interval: 30000
    running: true
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.openFromHotkey() }
    function close(): void { root.close() }
    function show(): void { root.openFromHotkey() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): void {
      if (root.hostWidget && typeof root.hostWidget.broadcast === "function")
        root.hostWidget.broadcast("refresh")
      else root.refresh()
    }
  }

  // ---- Popup UI.
  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(440))
    contentHeight: panel.fittedContentHeight(contentColumn.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onMoveRequested: function(dx, dy) { root.moveCursor(dy) }
      // Single activate (Space maps here too); returnRequested would fire it a
      // second time on the same Return press.
      onActivateRequested: root.openSelected()
      onDeleteRequested: root.markSelectedDone()
      onTextKey: function(t) {
        if (t === "r") root.refresh()
        else if (t === "o") root.openSelected()
        else if (t === "m" || t === "a") root.markSelectedDone()
        else if (t === "c") root.markAllDone()
      }

      Flickable {
        anchors.fill: parent
        contentWidth: width
        contentHeight: contentColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        Column {
          id: contentColumn
          width: parent.width
          spacing: Style.space(10)

          // ---- Hero: title + account + spend meter.
          Item {
            width: parent.width
            height: heroCol.implicitHeight

            Column {
              id: heroCol
              anchors.left: parent.left
              anchors.leftMargin: Style.space(16)
              anchors.right: parent.right
              anchors.rightMargin: Style.space(16)
              spacing: Style.space(4)

              Text {
                text: "X FILES"
                textFormat: Text.PlainText
                color: root.bar ? root.bar.foreground : Color.foreground
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.title
                font.bold: true
                font.letterSpacing: 1
              }

              Text {
                text: {
                  if (!true) return "Loading…"
                  if (!root.configured) return "Run x-files-login to connect your X account."
                  return "@" + root.accountUsername
                    + " · token ending " + root.accountLast4
                }
                textFormat: Text.PlainText
                color: root.bar ? Qt.darker(root.bar.foreground, 1.4) : Color.muted
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.caption
                font.letterSpacing: 1
              }

              // Spend meter, display controlled by the spendMeter setting. The
              // exact figure shows in Full mode (and On-alert near the cap); a
              // calm fill bar shows in Compact; nothing shows in Off. The exact
              // amount is always on the pill tooltip regardless.
              readonly property string spendMode: root.spendMeter
              readonly property real spendFrac:
                Model.spendFraction(root.ledger, root.capUsd, root.nowMs)
              readonly property bool spendNear:
                Model.spendNearCap(root.ledger, root.capUsd, root.nowMs)

              Text {
                visible: root.configured
                  && Model.showSpendLine(heroCol.spendMode, root.ledger, root.capUsd, root.nowMs)
                text: Model.spendText(root.ledger, root.nowMs)
                  + " · cap " + Model.usd(root.capUsd)
                textFormat: Text.PlainText
                color: root.bar ? root.bar.foreground : Color.foreground
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.bodySmall
              }

              // Compact mode: a slim fill bar, no dollar figure to stare at. It
              // tints toward the alert color as spend nears the cap.
              Item {
                visible: root.configured && heroCol.spendMode === "Compact"
                width: parent.width
                height: Style.space(8)

                Rectangle {
                  anchors.verticalCenter: parent.verticalCenter
                  width: parent.width
                  height: Style.space(5)
                  radius: height / 2
                  color: root.bar ? Qt.darker(root.bar.foreground, 2.2) : Color.muted
                  opacity: 0.35

                  Rectangle {
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    width: Math.max(0, Math.min(1, heroCol.spendFrac)) * parent.width
                    height: parent.height
                    radius: height / 2
                    color: heroCol.spendNear
                      ? (root.bar ? root.bar.urgent : Color.urgent)
                      : (root.bar ? root.bar.foreground : Color.foreground)
                  }
                }
              }
            }
          }

          // ---- Hard-stop banner at the spend cap.
          Rectangle {
            visible: root.stopped
            width: parent.width - Style.space(32)
            anchors.horizontalCenter: parent.horizontalCenter
            height: capText.implicitHeight + Style.space(12)
            radius: Style.cornerRadius
            color: root.bar ? root.bar.urgent : Color.urgent

            Text {
              id: capText
              anchors.centerIn: parent
              width: parent.width - Style.space(16)
              text: "Monthly spend cap reached. Polling is paused until next month, or raise the cap in settings."
              textFormat: Text.PlainText
              wrapMode: Text.WordWrap
              horizontalAlignment: Text.AlignHCenter
              color: root.bar ? root.bar.background : Color.background
              font.family: root.bar ? root.bar.fontFamily : Style.font.family
              font.pixelSize: Style.font.bodySmall
              font.bold: true
            }
          }

          // ---- NEEDS YOUR REPLY queue.
          Column {
            visible: root.configured
            width: parent.width
            spacing: Style.space(2)

            PanelSeparator { foreground: root.bar ? root.bar.foreground : Color.foreground }

            PanelSectionHeader {
              text: "NEEDS YOUR REPLY" + (root.openQueue.length > 0 ? " · " + root.openQueue.length : "")
              leftPadding: Style.space(16)
              foreground: root.bar ? root.bar.foreground : Color.foreground
              fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
            }

            Text {
              visible: root.openQueue.length === 0
              anchors.left: parent.left
              anchors.leftMargin: Style.space(16)
              text: "Queue drained. Nothing is waiting on you."
              textFormat: Text.PlainText
              color: root.bar ? Qt.darker(root.bar.foreground, 1.35) : Color.muted
              font.family: root.bar ? root.bar.fontFamily : Style.font.family
              font.pixelSize: Style.font.body
            }

            Repeater {
              model: root.openQueue

              Item {
                id: qItem
                required property var modelData
                required property int index
                readonly property bool isSelected: index === root.selIdx
                width: contentColumn.width
                height: qCol.implicitHeight + Style.space(8)

                Rectangle {
                  visible: qItem.isSelected
                  anchors.fill: parent
                  anchors.leftMargin: Style.space(8)
                  anchors.rightMargin: Style.space(8)
                  radius: Style.cornerRadius
                  color: root.bar ? root.bar.foreground : Color.foreground
                  opacity: 0.12
                }

                MouseArea {
                  anchors.fill: parent
                  acceptedButtons: Qt.LeftButton | Qt.RightButton
                  onClicked: function(mouse) {
                    // selIdx is a readonly, id-derived computed property; move
                    // the cursor by setting the tracked id, not the index.
                    root.selectedId = qItem.modelData.id
                    if (mouse.button === Qt.RightButton) root.markSelectedDone()
                    else root.openSelected()
                  }
                }

                Column {
                  id: qCol
                  anchors.left: parent.left
                  anchors.leftMargin: Style.space(16)
                  anchors.right: parent.right
                  anchors.rightMargin: Style.space(16)
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(1)

                  Row {
                    spacing: Style.space(8)
                    Text {
                      text: "@" + qItem.modelData.authorUsername
                      textFormat: Text.PlainText
                      color: root.bar ? root.bar.foreground : Color.foreground
                      font.family: root.bar ? root.bar.fontFamily : Style.font.family
                      font.pixelSize: Style.font.bodySmall
                      font.bold: true
                    }
                    Text {
                      text: qItem.modelData.bucket.replace("_", " ")
                        + (qItem.modelData.dupCount > 0 ? " · +" + qItem.modelData.dupCount + " similar" : "")
                      textFormat: Text.PlainText
                      color: root.bar ? Qt.darker(root.bar.foreground, 1.35) : Color.muted
                      font.family: root.bar ? root.bar.fontFamily : Style.font.family
                      font.pixelSize: Style.font.caption
                    }
                    Text {
                      text: Model.ageText(qItem.modelData.createdMs, root.nowMs)
                      textFormat: Text.PlainText
                      color: root.bar ? Qt.darker(root.bar.foreground, 1.45) : Color.muted
                      font.family: root.bar ? root.bar.fontFamily : Style.font.family
                      font.pixelSize: Style.font.caption
                    }
                  }

                  Text {
                    width: qCol.width
                    text: qItem.modelData.text
                    textFormat: Text.PlainText
                    wrapMode: Text.WordWrap
                    maximumLineCount: 2
                    elide: Text.ElideRight
                    color: root.bar ? root.bar.foreground : Color.foreground
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.body
                  }
                }
              }
            }
          }

          // ---- Per-post digests.
          Column {
            visible: root.configured && root.posts.length > 0
            width: parent.width
            spacing: Style.space(2)

            PanelSeparator { foreground: root.bar ? root.bar.foreground : Color.foreground }

            PanelSectionHeader {
              text: "YOUR RECENT POSTS"
              leftPadding: Style.space(16)
              foreground: root.bar ? root.bar.foreground : Color.foreground
              fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
            }

            Repeater {
              model: root.posts

              Item {
                required property var modelData
                width: contentColumn.width
                height: dCol.implicitHeight + Style.space(10)

                Column {
                  id: dCol
                  anchors.left: parent.left
                  anchors.leftMargin: Style.space(16)
                  anchors.right: parent.right
                  anchors.rightMargin: Style.space(16)
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(2)

                  Text {
                    width: dCol.width
                    text: modelData.postText
                    textFormat: Text.PlainText
                    wrapMode: Text.WordWrap
                    maximumLineCount: 1
                    elide: Text.ElideRight
                    color: root.bar ? root.bar.foreground : Color.foreground
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.body
                    font.bold: true
                  }

                  Text {
                    text: modelData.totalReplies + (modelData.totalReplies === 1 ? " reply" : " replies")
                      + (modelData.velocity > 0 ? " · " + modelData.velocity + "/hr" : "")
                      + (Model.bucketChips(modelData.buckets) !== "" ? " · " + Model.bucketChips(modelData.buckets) : "")
                    textFormat: Text.PlainText
                    color: root.bar ? Qt.darker(root.bar.foreground, 1.35) : Color.muted
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.caption
                  }

                  // Optional AI summary (two-pass: classify local, summarize
                  // survivors) sits above the raw quotes when present.
                  Text {
                    visible: modelData.summary !== ""
                    width: dCol.width
                    text: modelData.summary
                    textFormat: Text.PlainText
                    wrapMode: Text.WordWrap
                    color: root.bar ? Qt.darker(root.bar.foreground, 1.15) : Color.muted
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.bodySmall
                  }

                  Repeater {
                    model: modelData.quotes

                    Text {
                      required property var modelData
                      width: dCol.width
                      text: "“" + modelData.text + "”  @" + modelData.username
                      textFormat: Text.PlainText
                      wrapMode: Text.WordWrap
                      color: root.bar ? Qt.darker(root.bar.foreground, 1.25) : Color.muted
                      font.family: root.bar ? root.bar.fontFamily : Style.font.family
                      font.pixelSize: Style.font.bodySmall
                      font.italic: true
                    }
                  }
                }
              }
            }
          }

          // ---- Footer: keys + boundary honesty.
          Column {
            width: parent.width
            spacing: Style.space(2)

            PanelSeparator { foreground: root.bar ? root.bar.foreground : Color.foreground }

            Text {
              anchors.left: parent.left
              anchors.leftMargin: Style.space(16)
              text: "j/k move · enter open · x done · c clear · r refresh"
              textFormat: Text.PlainText
              color: root.bar ? Qt.darker(root.bar.foreground, 1.45) : Color.muted
              font.family: root.bar ? root.bar.fontFamily : Style.font.family
              font.pixelSize: Style.font.caption
            }

            Text {
              anchors.left: parent.left
              anchors.leftMargin: Style.space(16)
              text: "Buckets and quotes, never a sentiment score. The spend meter is your bill, live."
              textFormat: Text.PlainText
              color: root.bar ? Qt.darker(root.bar.foreground, 1.45) : Color.muted
              font.family: root.bar ? root.bar.fontFamily : Style.font.family
              font.pixelSize: Style.font.caption
            }
          }

          Item { width: 1; height: Style.space(4) }
        }
      }
    }
  }
}
