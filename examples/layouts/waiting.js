// An Agent Deck layout: only the sessions that wait on you, as tiles.
// Copy it to ~/.config/agent-deck/layouts/ and reload the page; "Waiting" joins the layouts.
AgentDeck.registerLayout({
  id: "waiting",
  label: "Waiting",
  title: "Only the sessions that wait on you",
  paint(root, deck) {
    if (!root.firstChild) root.innerHTML = '<div class="grid-tiles"></div>';
    const waiting = deck.sessions().filter((s) => s.state === "needs-answer" || s.state === "your-turn");
    deck.cards(root.firstChild, waiting, "tile");
  },
});
