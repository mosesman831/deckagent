import "./popup.css";

function main() {
  const app = document.getElementById("app");
  if (!app) return;
  app.innerHTML += "<p>Popup ready.</p>";
}

main();
