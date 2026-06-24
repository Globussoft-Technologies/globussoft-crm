// Converts a plain-text email body to safe HTML:
//   • newlines → <br>
//   • bare http(s) URLs → <a href="..."> so they're clickable in email clients
// Used by all travel cron content builders so every email link is clickable.
function textToHtml(text) {
  return String(text)
    .replace(/\n/g, "<br>")
    .replace(
      /(https?:\/\/[^\s<"]+)/g,
      '<a href="$1" style="color:#2563eb;text-decoration:underline">$1</a>',
    );
}

module.exports = { textToHtml };
