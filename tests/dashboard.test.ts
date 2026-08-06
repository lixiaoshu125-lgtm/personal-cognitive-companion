import { describe, expect, it } from "vitest";
import {
  buildDashboardData,
  renderStatusBar,
  renderActionArea,
  renderFooter,
  renderDashboardHTML,
  dispatchDashboardAction,
  DASHBOARD_VIEW_TYPE,
} from "../src/ui/dashboard";
import type { DashboardData } from "../src/composition";
import type { WeeklySnapshot } from "../src/domain/types";

// ─── Test Helpers ─────────────────────────────────────────────

function frozenSnapshot(overrides?: Partial<WeeklySnapshot>): WeeklySnapshot {
  return {
    snapshot_id: "snap-1",
    created_at: "2026-07-27T08:00:00.000Z",
    frozen_at: "2026-07-27T08:00:00.000Z",
    source_revision: "rev-1",
    note_ids: ["note-1", "note-2", "note-3"],
    cursor: 0,
    status: "frozen",
    ...overrides,
  } as WeeklySnapshot;
}

function activeSnapshot(overrides?: Partial<WeeklySnapshot>): WeeklySnapshot {
  return frozenSnapshot({ ...overrides, status: "active" });
}

function pausedSnapshot(overrides?: Partial<WeeklySnapshot>): WeeklySnapshot {
  return frozenSnapshot({ ...overrides, status: "paused" });
}

function completedSnapshot(overrides?: Partial<WeeklySnapshot>): WeeklySnapshot {
  return frozenSnapshot({ ...overrides, status: "completed" });
}

function emptyInput(overrides?: Partial<Parameters<typeof buildDashboardData>[0]>) {
  return {
    snapshot: null,
    previousCompletedNoteIds: undefined as readonly string[] | undefined,
    ...overrides,
  };
}

// ─── buildDashboardData Tests ─────────────────────────────────

describe("buildDashboardData", () => {
  // ── snapshotStatus ──

  it("returns no_snapshot status on first run (no snapshot)", () => {
    const data = buildDashboardData(emptyInput());
    expect(data.snapshotStatus).toBe("no_snapshot");
    expect(data.isFirstScan).toBe(false); // no snapshot → false
    expect(data.newNoteCount).toBe(0);
    expect(data.pendingTopicCount).toBe(0);
    expect(data.newsConfigured).toBe(false);
    expect(data.wikiPages).toEqual([]);
  });

  it("snapshot frozen → correct status", () => {
    const data = buildDashboardData({
      ...emptyInput(),
      snapshot: frozenSnapshot(),
    });
    expect(data.snapshotStatus).toBe("frozen");
  });

  it("snapshot active → correct status", () => {
    const data = buildDashboardData({
      ...emptyInput(),
      snapshot: activeSnapshot(),
    });
    expect(data.snapshotStatus).toBe("active");
  });

  it("snapshot paused → correct status", () => {
    const data = buildDashboardData({
      ...emptyInput(),
      snapshot: pausedSnapshot(),
    });
    expect(data.snapshotStatus).toBe("paused");
  });

  it("snapshot completed → correct status", () => {
    const data = buildDashboardData({
      ...emptyInput(),
      snapshot: completedSnapshot(),
    });
    expect(data.snapshotStatus).toBe("completed");
  });

  // ── newNoteCount & isFirstScan ──

  it("isFirstScan is true when snapshot exists and no previousCompletedNoteIds", () => {
    const data = buildDashboardData({
      ...emptyInput(),
      snapshot: frozenSnapshot({ note_ids: ["a", "b", "c"] }),
      previousCompletedNoteIds: undefined,
    });
    expect(data.isFirstScan).toBe(true);
    expect(data.newNoteCount).toBe(3);
  });

  it("isFirstScan is true when previousCompletedNoteIds is empty array", () => {
    const data = buildDashboardData({
      ...emptyInput(),
      snapshot: frozenSnapshot({ note_ids: ["a", "b"] }),
      previousCompletedNoteIds: [],
    });
    expect(data.isFirstScan).toBe(true);
    expect(data.newNoteCount).toBe(2);
  });

  it("incremental newNoteCount subtracts previousCompletedNoteIds", () => {
    const data = buildDashboardData({
      ...emptyInput(),
      snapshot: frozenSnapshot({
        note_ids: ["note-1", "note-2", "note-3", "note-4", "note-5"],
      }),
      previousCompletedNoteIds: ["note-1", "note-2"],
    });
    expect(data.isFirstScan).toBe(false);
    expect(data.newNoteCount).toBe(3); // 5 - 2
  });

  it("newNoteCount is 0 when all notes were in previous", () => {
    const data = buildDashboardData({
      ...emptyInput(),
      snapshot: frozenSnapshot({ note_ids: ["note-1", "note-2"] }),
      previousCompletedNoteIds: ["note-1", "note-2"],
    });
    expect(data.isFirstScan).toBe(false);
    expect(data.newNoteCount).toBe(0);
  });

  it("no snapshot → newNoteCount is 0, isFirstScan false", () => {
    const data = buildDashboardData({
      ...emptyInput(),
      previousCompletedNoteIds: ["note-1"],
    });
    expect(data.newNoteCount).toBe(0);
    expect(data.isFirstScan).toBe(false);
  });

  // ── pendingTopicCount & other new fields ──

  it("pendingTopicCount defaults to 0", () => {
    const data = buildDashboardData(emptyInput());
    expect(data.pendingTopicCount).toBe(0);
    expect(data.newsConfigured).toBe(false);
    expect(data.wikiPages).toEqual([]);
  });

  it("pendingTopicCount, newsConfigured, and wikiPages are passed through", () => {
    const wikiPage = { path: "wiki/test.md", title: "Test", created: "2026-01-01" };
    const data = buildDashboardData({
      ...emptyInput(),
      pendingTopicCount: 5,
      newsConfigured: true,
      wikiPages: [wikiPage],
    });
    expect(data.pendingTopicCount).toBe(5);
    expect(data.newsConfigured).toBe(true);
    expect(data.wikiPages).toEqual([wikiPage]);
  });
});

// ─── renderStatusBar Tests ────────────────────────────────────

describe("renderStatusBar", () => {
  it("shows muted badge for no_snapshot", () => {
    const data: DashboardData = {
      snapshotStatus: "no_snapshot",
      newNoteCount: 0,
      isFirstScan: false,
      pendingTopicCount: 0,
      newsConfigured: false,
      wikiPages: [],
    };
    const html = renderStatusBar(data);
    expect(html).toContain("cc-badge--muted");
    expect(html).toContain("无快照");
    expect(html).toContain("本周新增 0 条笔记");
  });

  it("shows info badge for frozen", () => {
    const data: DashboardData = {
      snapshotStatus: "frozen",
      newNoteCount: 5,
      isFirstScan: false,
      pendingTopicCount: 0,
      newsConfigured: false,
      wikiPages: [],
    };
    const html = renderStatusBar(data);
    expect(html).toContain("cc-badge--info");
    expect(html).toContain("已冻结");
    expect(html).toContain("本周新增 5 条笔记");
  });

  it("shows (首次扫描) label on first scan", () => {
    const data: DashboardData = {
      snapshotStatus: "frozen",
      newNoteCount: 100,
      isFirstScan: true,
      pendingTopicCount: 0,
      newsConfigured: false,
      wikiPages: [],
    };
    const html = renderStatusBar(data);
    expect(html).toContain("100 条笔记（首次扫描）");
  });

  it("shows active badge for active status", () => {
    const data: DashboardData = {
      snapshotStatus: "active",
      newNoteCount: 3,
      isFirstScan: false,
      pendingTopicCount: 0,
      newsConfigured: false,
      wikiPages: [],
    };
    const html = renderStatusBar(data);
    expect(html).toContain("cc-badge--active");
    expect(html).toContain("进行中");
  });

  it("shows warning badge for paused status", () => {
    const data: DashboardData = {
      snapshotStatus: "paused",
      newNoteCount: 0,
      isFirstScan: false,
      pendingTopicCount: 0,
      newsConfigured: false,
      wikiPages: [],
    };
    const html = renderStatusBar(data);
    expect(html).toContain("cc-badge--warning");
    expect(html).toContain("已暂停");
  });

  it("shows success badge for completed status", () => {
    const data: DashboardData = {
      snapshotStatus: "completed",
      newNoteCount: 0,
      isFirstScan: false,
      pendingTopicCount: 0,
      newsConfigured: false,
      wikiPages: [],
    };
    const html = renderStatusBar(data);
    expect(html).toContain("cc-badge--success");
    expect(html).toContain("已完成");
  });

  it("shows hotspot badge when news is configured", () => {
    const data: DashboardData = {
      snapshotStatus: "frozen",
      newNoteCount: 0,
      isFirstScan: false,
      pendingTopicCount: 0,
      newsConfigured: true,
      wikiPages: [],
    };
    const html = renderStatusBar(data);
    expect(html).toContain("热点已启用");
  });
});

// ─── renderActionArea Tests ───────────────────────────────────

describe("renderActionArea", () => {
  it("renders four direct home actions instead of command-palette instructions", () => {
    const data: DashboardData = {
      snapshotStatus: "frozen",
      newNoteCount: 3,
      isFirstScan: false,
      pendingTopicCount: 0,
      newsConfigured: false,
      wikiPages: [],
    };
    const html = renderActionArea(data);
    expect(html).toContain('data-action="free-question"');
    expect(html).toContain('data-action="current-note"');
    expect(html).toContain('data-action="weekly-review"');
    expect(html).toContain('data-action="continue-conversation"');
    expect(html).not.toContain("命令面板");
  });

  it("renders the topic action button", () => {
    const data: DashboardData = {
      snapshotStatus: "active",
      newNoteCount: 0,
      isFirstScan: false,
      pendingTopicCount: 0,
      newsConfigured: false,
      wikiPages: [],
    };
    const html = renderActionArea(data);
    expect(html).toContain("待讨论主题");
  });

  it("dispatches each rendered action to its application callback", async () => {
    const called: string[] = [];
    const actions = {
      startFreeQuestion: () => { called.push("free"); },
      startCurrentNote: () => { called.push("note"); },
      startOrContinueWeeklyReview: () => { called.push("weekly"); },
      continueConversation: () => { called.push("continue"); },
      refreshTopics: () => { called.push("refresh"); },
    };

    await dispatchDashboardAction("free-question", actions);
    await dispatchDashboardAction("current-note", actions);
    await dispatchDashboardAction("weekly-review", actions);
    await dispatchDashboardAction("continue-conversation", actions);

    expect(called).toEqual(["free", "note", "weekly", "continue"]);
  });
});

// ─── renderFooter Tests ───────────────────────────────────────

describe("renderFooter", () => {
  it("includes plugin version", () => {
    const data: DashboardData = {
      snapshotStatus: "no_snapshot",
      newNoteCount: 0,
      isFirstScan: false,
      pendingTopicCount: 0,
      newsConfigured: false,
      wikiPages: [],
    };
    const html = renderFooter(data);
    expect(html).toContain("认知伴侣 v2.0");
  });

  it("includes data update timestamp", () => {
    const data: DashboardData = {
      snapshotStatus: "no_snapshot",
      newNoteCount: 0,
      isFirstScan: false,
      pendingTopicCount: 0,
      newsConfigured: false,
      wikiPages: [],
    };
    const html = renderFooter(data);
    expect(html).toContain("数据更新:");
  });
});

// ─── renderDashboardHTML Tests ────────────────────────────────

describe("renderDashboardHTML", () => {
  it("renders complete dashboard with all sections", () => {
    const data: DashboardData = {
      snapshotStatus: "frozen",
      newNoteCount: 5,
      isFirstScan: false,
      pendingTopicCount: 3,
      newsConfigured: true,
      wikiPages: [
        { path: "wiki/test.md", title: "Test Wiki", created: "2026-01-01" },
      ],
    };

    const html = renderDashboardHTML(data);

    // Each section should be present
    expect(html).toContain("cc-dashboard__status-bar");
    expect(html).toContain("cc-dashboard__actions");
    expect(html).toContain("cc-dashboard__wiki");
    expect(html).toContain("cc-dashboard__footer");

    // Root container
    expect(html).toContain('class="cc-dashboard"');
  });

  it("shows empty wiki hint when no pages", () => {
    const data: DashboardData = {
      snapshotStatus: "active",
      newNoteCount: 3,
      isFirstScan: false,
      pendingTopicCount: 0,
      newsConfigured: false,
      wikiPages: [],
    };
    const html = renderDashboardHTML(data);
    expect(html).toContain("暂无 Wiki 页面");
  });

  it("escapes user-provided text in wiki pages to prevent XSS", () => {
    const data: DashboardData = {
      snapshotStatus: "frozen",
      newNoteCount: 0,
      isFirstScan: false,
      pendingTopicCount: 0,
      newsConfigured: false,
      wikiPages: [
        {
          path: "wiki/evil.md",
          title: '<script>alert("XSS")</script>',
          created: "2026-01-01",
        },
      ],
    };

    const html = renderDashboardHTML(data);

    // Raw HTML tags should be escaped, not executed
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('alert("XSS")');

    // HTML entities should be encoded
    expect(html).toContain("&lt;"); // < encoded
  });

  it("escapes user content but does not strip it (user sees their text safely)", () => {
    const data: DashboardData = {
      snapshotStatus: "frozen",
      newNoteCount: 5,
      isFirstScan: false,
      pendingTopicCount: 0,
      newsConfigured: false,
      wikiPages: [
        { path: "wiki/key.md", title: "sk-1234567890abcdef", created: "" },
      ],
    };

    const html = renderDashboardHTML(data);
    // The text is escaped by escapeMarkdownText (dashes become \-).
    // Verify that the escaped content is present and no raw dangerous HTML is injected.
    expect(html).toContain("sk\\-1234567890abcdef");
    expect(html).not.toContain("<script>");
  });

  it("uses semantic HTML elements", () => {
    const data: DashboardData = {
      snapshotStatus: "frozen",
      newNoteCount: 0,
      isFirstScan: false,
      pendingTopicCount: 0,
      newsConfigured: false,
      wikiPages: [],
    };

    const html = renderDashboardHTML(data);
    expect(html).toContain("<section");
    expect(html).toContain("<footer");
    expect(html).toContain("<h2");
  });

  it("all CSS classes use cc- prefix", () => {
    const data: DashboardData = {
      snapshotStatus: "active",
      newNoteCount: 0,
      isFirstScan: false,
      pendingTopicCount: 0,
      newsConfigured: false,
      wikiPages: [],
    };

    const html = renderDashboardHTML(data);
    // Extract all class="..." values
    const classMatches = html.match(/class="([^"]+)"/g) ?? [];
    for (const match of classMatches) {
      const classes = match.replace(/^class="/, "").replace(/"$/, "");
      // Every class should start with cc-
      for (const cls of classes.split(/\s+/)) {
        if (cls.length > 0) {
          expect(cls).toMatch(/^cc-/);
        }
      }
    }
  });
});

// ─── Constants Tests ──────────────────────────────────────────

describe("DASHBOARD_VIEW_TYPE", () => {
  it("is the expected string", () => {
    expect(DASHBOARD_VIEW_TYPE).toBe("cognitive-companion-dashboard");
  });
});
