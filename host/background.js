// The Windows login task runs this with wscript, which has no console, so the hub's own console stays hidden. A hub that
// stops is started again after ten seconds, as launchd and systemd do. WSH reads this file in the system code page, so it
// stays ASCII; the paths come in as arguments, which keep every character.
var shell = new ActiveXObject("WScript.Shell");
var words = [];
for (var i = 0; i < WScript.Arguments.length; i++) {
  words.push('"' + WScript.Arguments(i).replace(/(\\+)$/, "$1$1") + '"');
}
for (;;) {
  shell.Run(words.join(" "), 0, true);
  WScript.Sleep(10000);
}
