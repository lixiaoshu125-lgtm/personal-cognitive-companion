/**
 * PreparedTopicSuggestModal — presents AI-generated weekly topics
 * for the user to choose from, replacing the old TextInputModal
 * that required manual topic title entry.
 *
 * S1-ISSUE-08/09: Weekly entry connected to real PreparedTopic selection.
 */

import { App, SuggestModal } from "obsidian";
import type { PreparedTopic } from "../weekly/preparation-service";

export class PreparedTopicSuggestModal extends SuggestModal<PreparedTopic> {
  constructor(
    app: App,
    private readonly topics: readonly PreparedTopic[],
    private readonly onChoose: (topic: PreparedTopic) => void,
  ) {
    super(app);
    this.setPlaceholder("输入关键词筛选候选主题…");
  }

  getSuggestions(query: string): PreparedTopic[] {
    const q = query.toLowerCase().trim();
    if (!q) return [...this.topics];
    return this.topics.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    );
  }

  renderSuggestion(topic: PreparedTopic, el: HTMLElement): void {
    let statusLabel = "";
    if (topic.status === "in_progress") {
      statusLabel = " [继续讨论]";
    } else if (topic.status === "discussed") {
      statusLabel = " [重新讨论]";
    }
    el.createEl("div", { text: topic.title + statusLabel, cls: "pcc-suggest-title" });
    el.createEl("small", {
      text: topic.description.slice(0, 120) + (topic.description.length > 120 ? "…" : ""),
      cls: "pcc-suggest-desc",
    });
    // Relevance indicator
    const stars = Math.round(topic.relevance_score * 5);
    el.createEl("span", {
      text: `  ${"★".repeat(stars)}${"☆".repeat(5 - stars)}`,
      cls: "pcc-suggest-score",
    });
    // Tag for source type — use explicit is_news_related marker
    if (topic.is_news_related) {
      el.createEl("span", {
        text: " 🔥热点",
        cls: "pcc-suggest-tag pcc-suggest-tag--hot",
      });
    }
  }

  onChooseSuggestion(topic: PreparedTopic): void {
    this.onChoose(topic);
  }
}
