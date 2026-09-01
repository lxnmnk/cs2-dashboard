// Общий для index.html и trades.html: показывает "Logged in as X" и кнопку Logout.
(async function () {
  try {
    const res = await fetch("/api/me");
    const data = await res.json();
    const whoami = document.getElementById("whoami");
    if (whoami) whoami.textContent = data.username ? `Logged in as ${data.username}` : "";
  } catch (e) {
    console.warn("Failed to load current user:", e);
  }
})();

document.getElementById("logoutBtn")?.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "login.html";
});
