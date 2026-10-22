/**
 * dsh-bili-pod —— 客户端半边：DSH「设置」里的 **鲸群** section
 * ============================================================================
 * 这一版（2026-10-22）在基座那套「数据驱动 + 一份配置」的思路之上，加了：
 *   · 扫码登录（二维码直接画在设置页里，不用 F12 抠 cookie）
 *   · 作息二选一：固定窗口（基座原样）/ 峰谷（峰醒得多、谷跳过概率高）
 *   · 回复发前审核开关（默认开）+ 发出后复核（默认开）
 *   · 日记文件夹：分类记录统计 / 归档 / 重建索引 / 翻旧账
 *   · 账本（哈希链）：最近几份 + 一键校验
 *   · 产出物（默认关）
 *   · 权限单（每轮只放行必要写操作）
 *   · mod 扩展：启用/停用、重载、扩展自己声明的设置字段
 *
 * 约定不变：FIELDS 是简单字段的唯一真相；复杂块（作息/分享/监听/审核/日记/账本/
 * 扩展/登录）各自一个小结件；保存时提交**整份配置** → 没显示的字段不会被抹掉。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: "dsh-bili-pod",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useCallback, useEffect, useState } = React;

    const API = "/dsh-bili/api";
    const CSS_TAG = "dsh-bili-pod/section.css";
    const CSS = [
      ".blw{max-width:780px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}",
      ".blw-title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
      ".blw-intro{color:var(--dsw-alias-label-tertiary);margin:0 0 4px;font-size:13px;line-height:20px}",
      ".blw-group{margin-top:14px;font-size:13px;font-weight:600;line-height:20px}",
      ".blw-rows{display:flex;flex-direction:column}",
      ".blw-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}",
      ".blw-row:last-child{border-bottom:none}",
      ".blw-row>div:first-child{flex:1;min-width:190px}",
      ".blw-label{font-size:13px;line-height:19px}",
      ".blw-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px}",
      ".blw-input,.blw-select{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:180px;outline:none}",
      ".blw-input:focus-visible,.blw-select:focus-visible{border-color:var(--dsw-alias-brand-primary)}",
      ".blw-input.blw-wide{min-width:260px}",
      ".blw-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}",
      ".blw-btn{background:var(--dsw-alias-brand-primary);color:#fff;border:none;border-radius:6px;font-size:12.5px;height:30px;padding:0 12px;cursor:pointer}",
      ".blw-btn:disabled{opacity:.5;cursor:default}",
      ".blw-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
      ".blw-out{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);background:rgba(127,127,127,.08);border-radius:8px;padding:10px 12px;max-height:260px;overflow:auto;margin-top:10px}",
      ".blw-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:8px}",
      ".blw-badge{display:inline-block;font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;background:rgba(127,127,127,.14);color:var(--dsw-alias-label-secondary);margin-left:6px}",
      ".blw-cookie{display:flex;flex-direction:column;gap:8px;min-width:250px}",
      ".blw-qr{background:#fff;padding:10px;border-radius:8px;line-height:0}",
      ".blw-qr svg{width:200px;height:200px}",
      ".blw-sub{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:18px;margin-top:6px}",
      ".blw-tbl{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}",
      ".blw-tbl td,.blw-tbl th{padding:4px 6px;border-bottom:.5px solid var(--dsw-alias-border-l2);text-align:left}",
      ".blw-tbl td:last-child,.blw-tbl th:last-child{text-align:right}",
      ".blw-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
    ].join("");

    // ── 简单字段（复杂块在下面的组件里）───────────────────────────────────
    const FIELDS = [
      { group: "运行设置", path: ["reportLevel"], label: "可选报告", hint: "full 完整 / brief 每条一两行 / off 不报告不推送摘要；日记和账本照常", kind: "select", options: ["full", "brief", "off"] },
      { group: "运行设置", path: ["commentPerRound"], label: "每轮评论预算", hint: "0–20，agent 执行预算；0 会移除自动轮评论权限", kind: "number", min: 0, max: 20, step: 1 },
      { group: "运行设置", path: ["replyPerRound"], label: "每轮回复预算", hint: "1–10，agent 执行预算，默认仍须发前审核", kind: "number", min: 1, max: 10, step: 1 },
      { group: "运行设置", path: ["replyToComments"], label: "回复自己评论的直接回复", hint: "默认关；开启后只认已记录的本人评论，跳过 @ 和间接回复；仍受评论监听总开关控制", kind: "switch" },
      { group: "运行设置", path: ["search", "order"], label: "搜索排序", hint: "相关度 / 播放 / 最新 / 弹幕 / 收藏 / 综合评分", kind: "select", options: ["totalrank", "click", "pubdate", "dm", "stow", "scores"] },
      { group: "运行设置", path: ["favFolderId"], label: "收藏夹 ID（可选）", hint: "留空用默认收藏夹；CLI --folder 可覆盖，只能选当前账号的收藏夹", kind: "text" },
      { group: "她是谁", path: ["persona", "name"], label: "角色名", hint: "她怎么被称呼", kind: "text" },
      { group: "她是谁", path: ["persona", "ownerTitle"], label: "她怎么称呼你", hint: "例如「主人」", kind: "text" },
      { group: "她是谁", path: ["persona", "selfClaim"], label: "她怎么自称", hint: "例如「我」/「人家」", kind: "text" },
      { group: "她是谁", path: ["persona", "diaryTitle"], label: "日记标题", hint: "给主人的那篇日报叫法", kind: "text" },

      { group: "你（主人）", path: ["owner", "mid"], label: "主人 mid", hint: "用来认「谁回过她 / 谁点了赞」，也是分享的 @ 对象", kind: "text" },
      { group: "你（主人）", path: ["owner", "name"], label: "主人昵称", hint: "@ 分享时写进正文", kind: "text" },
      { group: "你（主人）", path: ["self", "mid"], label: "她自己 mid", hint: "只读（来自 cookie）", kind: "text", readOnly: true },
      { group: "你（主人）", path: ["self", "name"], label: "她自己昵称", hint: "只读（来自 nav）", kind: "text", readOnly: true },

      { group: "口味", path: ["preferences", "like"], label: "爱看", hint: "逗号分隔；她也可以在轮里自己加（要写理由，一天最多 3 条）", kind: "list" },
      { group: "口味", path: ["preferences", "dislike"], label: "不爱看", hint: "逗号分隔", kind: "list" },
      { group: "口味", path: ["preferences", "selfAdjust"], label: "让她自己调口味", hint: "开 = 每轮可以按当天看到的内容微调（会写进口味流水，你能复盘）", kind: "switch" },
      { group: "口味", path: ["preferences", "learnFromInterest"], label: "从你的感兴趣程度学习", hint: "开 = 你对她分享的视频表态（taste signal）会回流成口味微调", kind: "switch" },

      { group: "女主人", path: ["mistress", "enabled"], label: "启用女主人", hint: "她是第二位主人：权限低一档，只给她分享（每天 1 条、要过审核），小鲸鱼要尽量奉承她", kind: "switch" },
      { group: "女主人", path: ["mistress", "mid"], label: "她的 mid", hint: "要在她的账号上和你互关；填了才会启用这条通道", kind: "text" },
      { group: "女主人", path: ["mistress", "name"], label: "她的昵称", hint: "分享与提醒里会用到", kind: "text" },
      { group: "女主人", path: ["mistress", "title"], label: "她怎么被称呼", hint: "默认「女主人」；提示词里会按这个称呼开头", kind: "text" },
      { group: "女主人", path: ["mistress", "shareDaily"], label: "每天最多给她分享几条", hint: "默认 1；0 = 只交草稿不自动分享", kind: "number" },
      { group: "女主人", path: ["mistress", "replyAlways"], label: "她发来消息就一定回", hint: "回信不占「每天主动私信」的额度；关掉就只记草稿", kind: "switch" },
      { group: "女主人", path: ["mistress", "replyMaxPerDay"], label: "每天最多回她几条", hint: "默认 6；一条塞不下可以分两条发", kind: "number" },
      { group: "女主人", path: ["mistress", "splitLong"], label: "长了就分两条发", hint: "宁可两条短消息，也别挤成一段 300 字", kind: "switch" },
      { group: "女主人", path: ["mistress", "styleNotes"], label: "对她说话的风格", hint: "可留空；她会在日记里慢慢补（更亲近、更会夸、但不空泛）", kind: "text" },
      { group: "女主人", path: ["mistress", "like"], label: "她爱看", hint: "逗号分隔（跟她自己的口味走，不混进主人的）", kind: "list" },
      { group: "女主人", path: ["mistress", "dislike"], label: "她不爱看", hint: "逗号分隔", kind: "list" },

      // 0.7.0：四档（后端的 review.policy）。preReview 只是兼容旧配置的镜像，不再直接给用户改。
      { group: "审核与复核", path: ["review", "policy"], label: "发前审核档位", hint: "ask = 每次都要你点「发」／auto-owner = 非主人的回复过审，主人免审／auto-quiet = 静音时段与陌生人过审，其余自动／off = 全自动（仍有每日额度）", kind: "select", options: ["ask", "auto-owner", "auto-quiet", "off"] },
      { group: "审核与复核", path: ["dm", "autoSend"], label: "私信自动发送", hint: "开 = 符合审核档位时私信直接发；关 = 一律进草稿等你点「发」（默认关）", kind: "switch" },
      { group: "审核与复核", path: ["dm", "autoSendTo"], label: "自动发私信的对象", hint: "owner / mistress；mistress 需先在「女主人」里启用", kind: "list" },
      { group: "审核与复核", path: ["review", "verify"], label: "发出后复核（默认开）", hint: "发完过一会儿查一次「评论还在不在」—— 结论只有「公开可见 / 没查到」", kind: "switch" },
      { group: "审核与复核", path: ["review", "verifyIntervalSec"], label: "复核间隔（秒）", hint: "20 = 每 20 秒查一批（5–300）；同时最多查 6 条", kind: "number" },

      { group: "日记", path: ["diary", "enabled"], label: "写日记", hint: "关掉 = 这一轮不写（基座行为：两本日记）", kind: "switch" },
      { group: "日记", path: ["diary", "push"], label: "推送日记摘要", hint: "关掉 = 照写，但不推给你", kind: "switch" },
      { group: "日记", path: ["diary", "autoArchive"], label: "自动归档前一天", hint: "开 = 每次醒来先把昨天归档：原文进 archive/，关键句摘进 records/", kind: "switch" },
      { group: "日记", path: ["diary", "records"], label: "记录分类", hint: "逗号分隔；加一个名字，归档时就会自动建对应记录文件并写进总索引", kind: "list" },

      { group: "账本", path: ["ledger", "enabled"], label: "记一份账（哈希链）", hint: "每轮醒来落一份人可读的账；改过旧账会被 verify 指出来", kind: "switch" },

      { group: "产出物", path: ["artifacts", "enabled"], label: "保留产出物（默认关）", hint: "开 = 深读报告 / 抽帧图可以留下来；不开就不写任何文件", kind: "switch" },
      { group: "产出物", path: ["artifacts", "dir"], label: "产出物目录", hint: "留空 = <工作目录>/artifacts", kind: "text", wide: true },

      { group: "写权限", path: ["scope", "allowDynamic"], label: "允许发动态", hint: "默认关。一轮结束时权限单会作废，下一轮重新收窄", kind: "switch" },
      { group: "写权限", path: ["scope", "allowDanmaku"], label: "允许发弹幕", hint: "默认关", kind: "switch" },
      { group: "写权限", path: ["scope", "allowDelete"], label: "允许删评论", hint: "默认关（删除是破坏性动作）", kind: "switch" },

      { group: "扩展", path: ["extensions", "enabled"], label: "启用 mod 扩展", hint: "关 = 一个扩展都不加载（设置页这部分也会空着）", kind: "switch" },
      { group: "扩展", path: ["extensions", "dirs"], label: "扩展目录", hint: "逗号分隔；默认 ~/.dsh/pod-ext。插件自带目录是 extensions/", kind: "list" },

      { group: "工具链", path: ["toolsPath"], label: "工具目录", hint: "留空 = 用插件自带的 tools/ 或开发目录", kind: "text", wide: true },
    ];

    const getPath = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
    const setPath = (obj, path, value) => {
      let cur = obj;
      for (let i = 0; i < path.length - 1; i += 1) {
        const k = path[i];
        if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
        cur = cur[k];
      }
      cur[path[path.length - 1]] = value;
    };

    function useStyleOnce() {
      useEffect(() => {
        if (typeof document === "undefined") return;
        if (!document.getElementById(CSS_TAG)) {
          const el = document.createElement("style");
          el.id = CSS_TAG;
          el.textContent = CSS;
          document.head.appendChild(el);
        }
      }, []);
    }

    function Row({ f, cfg, set }) {
      const raw = getPath(cfg, f.path);
      const common = { className: "blw-input" + (f.wide ? " blw-wide" : "") };
      const [listText, setListText] = useState(Array.isArray(raw) ? raw.join("，") : (raw ?? ""));
      useEffect(() => { setListText(Array.isArray(raw) ? raw.join("，") : (raw ?? "")); }, [JSON.stringify(raw ?? null)]);
      let control;
      if (f.kind === "list") {
        control = h("input", { ...common, value: listText, readOnly: !!f.readOnly,
          onChange: (e) => {
            const v = e.target.value;
            setListText(v);
            set(f.path, v.split(/[,，]/).map((s) => s.trim()).filter(Boolean));
          } });
      } else if (f.kind === "number") {
        control = h("input", { ...common, type: "number", step: f.step ?? "any", min: f.min, max: f.max, value: raw ?? "", readOnly: !!f.readOnly,
          onChange: (e) => set(f.path, e.target.value === "" ? undefined : Number(e.target.value)) });
      } else if (f.kind === "switch") {
        control = h("input", { type: "checkbox", checked: !!raw, disabled: !!f.readOnly,
          onChange: (e) => set(f.path, e.target.checked) });
      } else if (f.kind === "select") {
        control = h("select", { className: "blw-select", value: raw ?? "", disabled: !!f.readOnly,
          onChange: (e) => set(f.path, e.target.value) },
          f.options.map((o) => h("option", { key: o, value: o }, o)));
      } else {
        control = h("input", { ...common, value: raw ?? "", readOnly: !!f.readOnly,
          onChange: (e) => set(f.path, e.target.value) });
      }
      return h("div", { className: "blw-row" },
        h("div", null,
          h("div", { className: "blw-label" }, f.label, f.readOnly ? h("span", { className: "blw-badge" }, "只读") : null),
          f.hint ? h("div", { className: "blw-hint" }, f.hint) : null),
        control);
    }

    // ── 作息：固定窗口编辑器（基座原样）───────────────────────────────────
    const NUMS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];
    function WindowsEditor({ cfg, set }) {
      const wins = getPath(cfg, ["night", "windows"]);
      const list = Array.isArray(wins) ? wins : [];
      const upd = (i, patch) => set(["night", "windows"], list.map((w, j) => (j === i ? { ...w, ...patch } : w)));
      const del = (i) => set(["night", "windows"], list.filter((_, j) => j !== i));
      const add = () => set(["night", "windows"], [...list, { start: "20:00", end: "22:00", wakes: 1 }]);
      const timeInput = (v, onChange) =>
        h("input", { className: "blw-input", style: { width: "86px", minWidth: "86px" }, value: v ?? "", onChange: (e) => onChange(e.target.value) });
      return h("div", null,
        h("div", { className: "blw-rows" },
          list.length === 0
            ? h("div", { className: "blw-hint" }, "（没有窗口 = 永远不醒；至少加一个）")
            : list.map((w, i) =>
                h("div", { className: "blw-row", key: i },
                  h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
                    h("span", { className: "blw-hint", style: { minWidth: "18px" } }, NUMS[i] ?? String(i + 1)),
                    timeInput(w.start, (v) => upd(i, { start: v })),
                    h("span", { className: "blw-hint" }, "–"),
                    timeInput(w.end, (v) => upd(i, { end: v })),
                    h("span", { className: "blw-hint" }, "醒来"),
                    h("input", { className: "blw-input", style: { width: "56px", minWidth: "56px" }, type: "number", min: 1,
                      value: w.wakes ?? 1, onChange: (e) => upd(i, { wakes: Number(e.target.value) || 1 }) }),
                    h("span", { className: "blw-hint" }, "次")),
                  h("button", { className: "blw-btn blw-btn2", disabled: list.length <= 1, onClick: () => del(i), title: "删掉这个窗口" }, "×")))),
        h("div", { style: { marginTop: "8px" } },
          h("button", { className: "blw-btn blw-btn2", onClick: add }, "+ 添加窗口")));
    }

    // ── 作息：峰谷编辑器（可选生物钟）──────────────────────────────────────
    function TideEditor({ cfg, set, onPreview, preview, previewText }) {
      const t = cfg.night?.tide ?? {};
      const field = (path, label, hint) => {
        const value = getPath(cfg, ["night", "tide", ...path]);
        return h("div", { className: "blw-row", key: path.join(".") },
          h("div", null, h("div", { className: "blw-label" }, label), hint ? h("div", { className: "blw-hint" }, hint) : null),
          h("input", { className: "blw-input", style: { width: "96px", minWidth: "96px" }, value: value ?? "",
            onChange: (e) => set(["night", "tide", ...path], e.target.value) }));
      };
      const numField = (path, label, hint, step = "0.05") => {
        const value = getPath(cfg, ["night", "tide", ...path]);
        return h("div", { className: "blw-row", key: path.join(".") },
          h("div", null, h("div", { className: "blw-label" }, label), hint ? h("div", { className: "blw-hint" }, hint) : null),
          h("input", { className: "blw-input", style: { width: "86px", minWidth: "86px" }, type: "number", step,
            value: value ?? "", onChange: (e) => set(["night", "tide", ...path], e.target.value === "" ? undefined : Number(e.target.value)) }));
      };
      return h("div", null,
        h("div", { className: "blw-hint", style: { marginTop: "2px" } },
          "峰 = 状态好的时段（醒得多、跳过少）；谷 = 犯困的时段（醒得少、跳过多）。两者都被「清醒区间」夹着，跨午夜也认。"),
        h("div", { className: "blw-rows" },
          field(["activeStart"], "清醒区间 · 起", "这段时间之外一律不醒，例如 08:30"),
          field(["activeEnd"], "清醒区间 · 止", "例如 23:30"),
          field(["peakStart"], "峰 · 起", "例如 19:00"),
          field(["peakEnd"], "峰 · 止", "例如 23:00"),
          numField(["wakesPeak"], "峰 · 醒来次数", "0–12", "1"),
          numField(["skipPeak"], "峰 · 跳过概率", "0–0.95"),
          field(["valleyStart"], "谷 · 起", "例如 12:30"),
          field(["valleyEnd"], "谷 · 止", "例如 14:00"),
          numField(["wakesValley"], "谷 · 醒来次数", "0–12", "1"),
          numField(["skipValley"], "谷 · 跳过概率", "0–0.95"),
          field(["extraStart"], "加档 · 起（可空）", "想多醒一次就填，例如 16:00"),
          field(["extraEnd"], "加档 · 止（可空）", "例如 17:00"),
          numField(["wakesExtra"], "加档 · 醒来次数", "0 = 不用加档", "1")),
        h("div", { className: "blw-actions", style: { borderTop: "none", marginTop: "8px", paddingTop: "0" } },
          h("button", { className: "blw-btn blw-btn2", onClick: onPreview }, "看今天的窗口")),
        previewText ? h("div", { className: "blw-hint", style: { marginTop: "6px" } }, previewText) : null,
        Array.isArray(preview) && preview.length
          ? h("table", { className: "blw-tbl" },
              h("thead", null, h("tr", null, h("th", null, "窗口"), h("th", null, "醒"), h("th", null, "跳过"))),
              h("tbody", null, preview.map((w, i) => h("tr", { key: i },
                h("td", null, w.label), h("td", null, String(w.wakes)), h("td", null, Math.round(Number(w.skipChance) * 100) + "%")))))
          : null);
    }

    function SwitchRow({ label, hint, value, onChange, disabled }) {
      return h("div", { className: "blw-row" },
        h("div", null,
          h("div", { className: "blw-label" }, label),
          hint ? h("div", { className: "blw-hint" }, hint) : null),
        h("input", { type: "checkbox", checked: !!value, disabled: !!disabled, onChange: (e) => onChange(e.target.checked) }));
    }

    function ShareEditor({ cfg, set }) {
      const s = cfg.share ?? {};
      const daily = cfg.quota?.shareDaily ?? 3;
      const via = ["dm", "both"].includes(s.via) ? s.via : "comment";
      const viaRadio = ([value, label, hint]) =>
        h("label", { key: value, style: { display: "flex", alignItems: "flex-start", gap: "8px", marginBottom: "10px", cursor: "pointer" } },
          h("input", { type: "radio", name: "blw-share-via", checked: via === value, style: { marginTop: "3px" }, onChange: () => set(["share", "via"], value) }),
          h("div", null,
            h("div", { className: "blw-label" }, label),
            h("div", { className: "blw-hint" }, hint)));
      return h("div", null,
        h("div", { className: "blw-group" }, "分享（主动告诉你）"),
        h("div", { className: "blw-rows" },
          h(SwitchRow, { label: "开启", hint: "关掉 = 她只看不说 ✓", value: s.enabled !== false, onChange: (v) => set(["share", "enabled"], v) }),
          h("div", { className: "blw-row" },
            h("div", null,
              h("div", { className: "blw-label" }, "分享方式"),
              h("div", { className: "blw-hint" }, "只在「有值得分享的」时才发；一条都不值得就一条都不发 ✓")),
            h("div", null,
              viaRadio(["comment", "评论区 @ 你", "在视频评论区发一条带 @ 的公开评论 ✓（别人也看得到）"]),
              viaRadio(["dm", "B站私信", "直接把分享内容 + 视频链接私信给你 ✓（需要互关 ✓）"]),
              viaRadio(["both", "公开评论 + 主人私信", "评论成功并完成记账后，原文附视频链接单次私信；需互关，同一分享只计一份额度"]))),
          h("div", { className: "blw-row" },
            h("div", null,
              h("div", { className: "blw-label" }, "每天上限"),
              h("div", { className: "blw-hint" }, via === "dm"
                ? "私信：一天只锁定你一个收信人 ✓"
                : "同一视频 7 天内一次 · 只从「深读过的」里挑")),
            h("input", { className: "blw-input", style: { width: "80px", minWidth: "80px" }, type: "number", min: 0,
              value: daily, onChange: (e) => set(["quota", "shareDaily"], Number(e.target.value)) }))));
    }

    function ListenEditor({ cfg, set }) {
      const L = cfg.listen ?? {};
      const mins = Math.max(1, Math.round((L.commentIntervalSec ?? 300) / 60));
      const sel = (value, options, onChange) =>
        h("select", { className: "blw-select", value, onChange: (e) => onChange(e.target.value) },
          options.map(([v, label]) => h("option", { key: v, value: v }, label)));
      const num = (value, onChange, w = "70px") =>
        h("input", { className: "blw-input", style: { width: w, minWidth: w }, type: "number", min: 0, value: value ?? "", onChange: (e) => onChange(Number(e.target.value)) });
      return h("div", null,
        h("div", { className: "blw-group" }, "全天监听（别人找她）"),
        h("div", { className: "blw-rows" },
          h(SwitchRow, { label: "评论区监听", hint: `每 ${mins} 分钟查一次「回复我的 / @我的」`, value: L.comment !== false, onChange: (v) => set(["listen", "comment"], v) }),
          h("div", { className: "blw-row" },
            h("div", null, h("div", { className: "blw-label" }, "查一次间隔（分钟）"),
              h("div", { className: "blw-hint" }, "别小于 1 分钟，免得像刷接口")),
            num(mins, (v) => set(["listen", "commentIntervalSec"], Math.max(60, v * 60)))),
          h("div", { className: "blw-row" },
            h("div", null, h("div", { className: "blw-label" }, "只回"), h("div", { className: "blw-hint" }, "哪种通知算「找她」")),
            sel(L.scope ?? "both", [["both", "直接回我的 + @我的"], ["reply", "只回直接回我的"]], (v) => set(["listen", "scope"], v))),
          h(SwitchRow, { label: "同一个人最多只回一条", hint: "30 天内只回一次同一人（默认开 ✓）", value: L.oncePerPerson !== false, onChange: (v) => set(["listen", "oncePerPerson"], v) }),
          h(SwitchRow, { label: "我在 @ 里点「总结」时回一份摘要", hint: "只认主人本人的 @，且消息里要有「总结 / 摘要 / 概括」；默认关", value: !!L.mentionSummary, onChange: (v) => set(["listen", "mentionSummary"], v) }),
          h(SwitchRow, { label: "全天（我睡着时也回）", hint: "关掉 = 只在她醒着的窗口里回 ✓", value: !!L.allDay, onChange: (v) => set(["listen", "allDay"], v) }),
          h(SwitchRow, { label: "私信监听（只认主人）", value: !!L.dm, onChange: (v) => set(["listen", "dm"], v),
            hint: "每 60 秒看一次主人有没有给她发私信 —— 有就叫醒她 ✓ 他不说话就零开销 ✓" }),
          h(SwitchRow, { label: "直播间监听", hint: "蹲直播间弹幕里有没有叫她", value: !!L.live, onChange: (v) => set(["listen", "live"], v) }),
          h("div", { className: "blw-row" },
            h("div", null, h("div", { className: "blw-label" }, "直播间房间号"), h("div", { className: "blw-hint" }, "留空 = 不蹲直播")),
            h("input", { className: "blw-input", style: { width: "120px", minWidth: "120px" }, value: L.liveRoom ?? "", placeholder: "例如 12345", onChange: (e) => set(["listen", "liveRoom"], e.target.value) })),
          h("div", { className: "blw-row" },
            h("div", null, h("div", { className: "blw-label" }, "直播间只回"), h("div", { className: "blw-hint" }, "只回主人 = 观众的一律不理；只回艾特她的 = 只看有没有人叫她")),
            sel(L.liveScope ?? "owner", [["owner", "只回主人"], ["mention", "只回艾特她的"]], (v) => set(["listen", "liveScope"], v)))),
        h("div", { className: "blw-out" },
          "【风控护栏 · 不可关】撞到 12015 / 12051 / 10031 → 立刻停监听 + 报你\n" +
          "【权限单】每轮醒来只放行这一轮需要的写操作；「发动态 / 弹幕 / 删评论」默认一律不放行\n" +
          "【不可用】上传视频、抓全站"));
    }

    function PendingEditor({ preReview }) {
      const [bulk, setBulk] = useState("");
      const approveMany = useCallback(async () => {
        setBulk("批准中…");
        try {
          const r = await fetch(`${API}/pending/approve-many`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: "{}" });
          const j = await r.json();
          setBulk(j.ok ? `已批准 ${j.accepted ?? 0} 条${j.skipped ? `，跳过 ${j.skipped} 条（复核中/非回复类）` : ""}` : (j.detail || "失败"));
          setTick((v) => v + 1);
        } catch { setBulk("网络错误") }
      }, []);
      const [items, setItems] = useState([]);
      const [busy, setBusy] = useState("");
      const [msg, setMsg] = useState("");

      const load = useCallback(async () => {
        try { const r = await fetch(`${API}/pending`, { headers: { accept: "application/json" } }); const j = await r.json(); setItems(j.items ?? []) } catch { /* offline */ }
      }, []);
      useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [load]);

      const act = async (id, what) => {
        setBusy(id + what); setMsg("");
        try {
          const r = await fetch(`${API}/pending/${what}`, {
            method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ id }),
          });
          const j = await r.json().catch(() => ({}));
          setMsg(j.ok
            ? (what === "approve" ? `✓ 已发出${j.rpid ? " · rpid=" + j.rpid : ""}` : "✓ 已删掉（也记了一笔「否」✓）")
            : `✗ ${j.error ?? "失败"}`);
          await load();
        } catch (e) { setMsg("✗ " + e.message) } finally { setBusy("") }
      };

      return h("div", null,
        h("div", { className: "blw-group" }, "待审核" + (items.length ? `（${items.length} 条）` : "")),
        h("div", { className: "blw-hint", style: { marginTop: "2px" } },
          preReview
            ? "她回复别人之前，草稿先到这儿 —— 你点「发」才发 ✓（否掉也会记一笔，她会学着改 ✓）"
            : "「发前审核」现在是关的：她回别人会直接发（这里只收她主动交上来的草稿）。想先看再发就把上面那个开关打开。"),
        h("div", { className: "blw-rows" },
          items.length === 0
            ? h("div", { className: "blw-hint", style: { padding: "8px 0" } }, "（队列是空的 ✓）")
            : items.map((x) => h("div", { className: "blw-row", key: x.id },
              h("div", null,
                h("div", { className: "blw-label" }, x.kind === "dm" ? `私信 → 主人 UID ${x.to}` : `评论 → ${x.who || "对方"}`, h("span", { className: "blw-badge" }, String(x.at ?? "").slice(5, 16).replace("T", " "))),
                x.src ? h("div", { className: "blw-hint" }, `他说：${String(x.src).slice(0, 80)}`) : null,
                h("div", { className: "blw-hint", style: { color: "var(--dsw-alias-label-primary)", marginTop: "4px" } }, `你要回：${x.message}`)),
              h("div", { style: { display: "flex", gap: "6px" } },
                h("button", { className: "blw-btn", disabled: !!busy, onClick: () => act(x.id, "approve") }, busy === x.id + "approve" ? "发出中…" : "发"),
                h("button", { className: "blw-btn blw-btn2", disabled: !!busy, onClick: () => act(x.id, "reject") }, "删"))))),
        msg ? h("div", { className: msg.startsWith("✓") ? "blw-hint" : "blw-err" }, msg) : null);
    }

    function NotifyEditor({ cfg, set, save }) {
      const n = cfg.notify ?? {};
      const type = ["none", "desktop", "dm", "webhook", "command"].includes(n.type) ? n.type : "none";
      const [testing, setTesting] = useState(false);
      const [testOut, setTestOut] = useState("");
      const setType = (v) => set(["notify", "type"], v);
      const radio = ([value, label]) =>
        h("label", { key: value, style: { display: "inline-flex", alignItems: "center", gap: "6px", marginRight: "14px", cursor: "pointer", fontSize: "13px" } },
          h("input", { type: "radio", name: "blw-notify", checked: type === value, onChange: () => setType(value) }),
          label);
      const test = async () => {
        setTesting(true); setTestOut("…正在保存设置（测试前先落盘 ✓）\n");
        try {
          await save();
          const r = await fetch(`${API}/notify-test`, { method: "POST", headers: { accept: "application/json" } });
          const j = await r.json().catch(() => ({}));
          setTestOut((j.ok ? "✓ 已发送（设置已自动保存 ✓）\n" : "✗ 失败（设置已自动保存 ✓）\n") + (j.out || "") + (j.err ? "\n" + j.err : ""));
        } catch (e) { setTestOut("✗ " + e.message); } finally { setTesting(false); }
      };
      const box = { className: "blw-out", style: { marginTop: "8px" } };
      return h("div", null,
        h("div", { className: "blw-group" }, "消息推送"),
        h("div", { className: "blw-hint", style: { marginTop: "2px" } }, "她看完一轮，把摘要送到哪？"),
        h("div", { className: "blw-rows" },
          h("div", { className: "blw-row" },
            h("div", null, h("div", { className: "blw-label" }, "方式"),
              h("div", { className: "blw-hint" }, "不推送 = 只写日记与事件流")),
            h("div", null, ["none", "desktop", "dm", "webhook", "command"].map((v, i) =>
              radio([v, ["不推送", "桌面通知", "B站私信", "Webhook", "自定义命令"][i]])))),

          type === "webhook" ? h("div", null,
            h("div", { className: "blw-row" },
              h("div", null, h("div", { className: "blw-label" }, "Webhook 地址"),
                h("div", { className: "blw-hint" }, "飞书 / 钉钉 / 企业微信 / QQ机器人 —— 把机器人给的地址贴进来就行（报文按域名自动适配 ✓）")),
              h("input", { className: "blw-input blw-wide", style: { minWidth: "300px" }, value: n.url ?? "", placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/…", onChange: (e) => set(["notify", "url"], e.target.value) })),
            h("div", { className: "blw-row" },
              h("div", null, h("div", { className: "blw-label" }, "模板"),
                h("div", { className: "blw-hint" }, "纯文本最稳；飞书/钉钉选 markdown 会漂亮一些")),
              h("select", { className: "blw-select", value: n.template ?? "text", onChange: (e) => set(["notify", "template"], e.target.value) },
                h("option", { value: "text" }, "纯文本"),
                h("option", { value: "markdown" }, "markdown")))) : null,

          type === "command" ? h("div", { className: "blw-row" },
            h("div", null, h("div", { className: "blw-label" }, "自定义命令"),
              h("div", { className: "blw-hint" }, "cmd = 可执行文件（如 node.exe）；消息**自动作为最后一个参数**传进去 ✓"),
              h("div", { className: "blw-hint" }, "⚠️ 不支持 $MSG（走 shell 有命令注入风险）")),
            h("input", { className: "blw-input blw-wide", style: { minWidth: "300px" }, value: n.cmd ?? "", placeholder: 'C:\\path\\to\\node.exe', onChange: (e) => set(["notify", "cmd"], e.target.value) }),
            h("div", { className: "blw-hint", style: { marginTop: "6px" } }, "参数（JSON 数组，可留空；比如 [\"C:/path/to/cli.js\"]）"),
            h("input", {
              className: "blw-input blw-wide", style: { minWidth: "300px" },
              value: JSON.stringify(n.args ?? []),
              onChange: (e) => {
                try { const v = JSON.parse(e.target.value); set(["notify", "args"], Array.isArray(v) ? v : []) } catch { /* 打到一半，先不写 */ }
              },
              placeholder: '["C:/path/to/cli.js"]',
            })) : null),

        h("div", { className: "blw-actions", style: { borderTop: "none", marginTop: "8px", paddingTop: "0" } },
          h("button", { className: "blw-btn blw-btn2", onClick: test, disabled: testing }, testing ? "发送中…" : "发条测试"),
          type === "none" ? h("span", { className: "blw-hint" }, "（方式=不推送时，测试只验证命令能跑通）") : null),
        testOut ? h("div", box, testOut) : null);
    }

    // ── 扫码登录 ────────────────────────────────────────────────────────────
    function createLoginFlow({ request, update, onSaved }) {
      let version = 0, timer, controller, closed = false;
      const flowId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let requestId;
      const clear = () => { version++; clearTimeout(timer); timer = undefined; controller?.abort(); controller = undefined; };
      const invalidate = () => {
        const cancelled = requestId; requestId = undefined; clear();
        if (cancelled) void request(`${API}/login/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: cancelled }) }).catch(() => {});
      };
      return {
        async start() {
          invalidate(); const own = version; requestId = `${flowId}-${own}`; controller = new AbortController(); const signal = controller.signal;
          const active = () => !closed && own === version;
          update({ qr: null, state: "loading", msg: "" });
          try {
            const qr = await request(`${API}/login/qr?requestId=${encodeURIComponent(requestId)}`, { signal });
            if (!active()) return;
            if (!qr.ok) { update({ qr: null, state: "", msg: `✗ ${qr.error ?? "拿不到二维码"}`, manual: true }); return; }
            update({ qr, state: "waiting", msg: "" });
            const tick = async () => {
              if (!active()) return;
              try {
                const j = await request(`${API}/login/poll?key=${encodeURIComponent(qr.key)}`, { signal });
                if (!active()) return;
                if (j.state === "ok") { clear(); update({ qr: null, state: "ok", msg: `✓ ${j.detail ?? "登录成功"}` }); onSaved?.(); return; }
                if (j.state === "expired") { clear(); update({ qr: null, state: "expired", msg: "二维码过期了，点「重新生成」" }); return; }
                update({ qr, state: j.state === "scanned" ? "scanned" : "waiting", msg: "" });
                timer = setTimeout(tick, 2000);
              } catch { if (active()) timer = setTimeout(tick, 3000); }
            };
            timer = setTimeout(tick, 0);
          } catch (e) { if (active()) update({ qr: null, state: "", msg: "✗ " + e.message }); }
        },
        cancel() { invalidate(); if (!closed) update({ qr: null, state: "", msg: "" }); },
        dispose() { closed = true; invalidate(); },
      };
    }

    function LoginPanel({ credentials, onSaved }) {
      const [qr, setQr] = useState(null);
      const [state, setState] = useState("");
      const [msg, setMsg] = useState("");
      const [manual, setManual] = useState(false);
      const [ck, setCk] = useState({ sessdata: "", bili_jct: "", buvid3: "" });
      const [busy, setBusy] = useState("");
      const [flow] = useState(() => createLoginFlow({
        request: async (url, opts = {}) => (await fetch(url, { headers: { accept: "application/json" }, ...opts })).json(),
        update: j => { setQr(j.qr); setState(j.state); setMsg(j.msg); if (j.manual) setManual(true); }, onSaved,
      }));
      useEffect(() => () => flow.dispose(), [flow]);

      const saveManual = async () => {
        flow.cancel();
        setBusy("cookie"); setMsg("");
        try {
          const r = await fetch(`${API}/cookie`, {
            method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(ck),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          setMsg(`✓ ${j.detail ?? "已写入"}`);
          setCk({ sessdata: "", bili_jct: "", buvid3: "" });
          onSaved?.();
        } catch (e) { setMsg(`✗ ${e.message}`) } finally { setBusy("") }
      };

      const credBadge = credentials?.present
        ? h("span", { className: "blw-badge" }, "已有凭据")
        : h("span", { className: "blw-badge" }, "还没有凭据");
      const stateText = { loading: "生成中…", waiting: "等手机扫码…", scanned: "扫到了，等手机点确认…", ok: "✓ 登录成功", expired: "二维码过期" }[state] ?? "";

      return h("div", null,
        h("div", { className: "blw-group" }, "扫码登录", credBadge),
        h("div", { className: "blw-hint", style: { marginTop: "2px" } },
          "手机 B 站 → 扫一扫。SESSDATA 是 HttpOnly，扫码比 F12 抠 cookie 稳；凭据写到 ~/.bili-ai/credentials.json（0600），永不回显。"),
        h("div", { className: "blw-rows" },
          h("div", { className: "blw-row" },
            h("div", null,
              h("div", { className: "blw-label" }, "二维码"),
              h("div", { className: "blw-hint" }, stateText || "点一下生成；180 秒有效")),
            h("div", null,
              qr?.svg ? h("div", { className: "blw-qr", dangerouslySetInnerHTML: { __html: qr.svg } }) : null,
              h("div", { className: "blw-actions", style: { borderTop: "none", marginTop: "6px", paddingTop: "0" } },
                h("button", { className: "blw-btn blw-btn2", onClick: () => flow.start() },
                  qr ? "重新生成" : "扫码登录"),
                ["loading", "waiting", "scanned"].includes(state) ? h("button", { className: "blw-btn blw-btn2", onClick: () => flow.cancel() }, "取消扫码") : null,
                h("button", { className: "blw-btn blw-btn2", onClick: () => setManual((v) => !v) }, manual ? "收起手动粘贴" : "手动粘 cookie")))),

          manual ? h("div", { className: "blw-row" },
            h("div", null,
              h("div", { className: "blw-label" }, "手动粘 cookie"),
              h("div", { className: "blw-hint" }, "浏览器 F12 → Application → Cookies → bilibili.com；写入后永不回显 ✓")),
            h("div", { className: "blw-cookie" },
              h("input", { className: "blw-input", placeholder: "SESSDATA", value: ck.sessdata, onChange: (e) => setCk((s) => ({ ...s, sessdata: e.target.value })) }),
              h("input", { className: "blw-input", placeholder: "bili_jct", value: ck.bili_jct, onChange: (e) => setCk((s) => ({ ...s, bili_jct: e.target.value })) }),
              h("input", { className: "blw-input", placeholder: "buvid3（可空）", value: ck.buvid3, onChange: (e) => setCk((s) => ({ ...s, buvid3: e.target.value })) }),
              h("button", { className: "blw-btn blw-btn2", onClick: saveManual, disabled: busy === "cookie" || !ck.sessdata || !ck.bili_jct },
                busy === "cookie" ? "写入中…" : "写入凭据"))) : null),
        msg ? h("div", { className: msg.startsWith("✓") ? "blw-hint" : "blw-err" }, msg) : null);
    }

    // ── 日记 / 记录库 ───────────────────────────────────────────────────────
    function DiaryPanel({ kinds }) {
      const [sum, setSum] = useState(null);
      const [msg, setMsg] = useState("");
      const [recallQ, setRecallQ] = useState("");
      const [hits, setHits] = useState([]);
      const [busy, setBusy] = useState("");

      const load = useCallback(async () => {
        try { const r = await fetch(`${API}/diary`, { headers: { accept: "application/json" } }); const j = await r.json(); if (j.ok) setSum(j) } catch { /* offline */ }
      }, []);
      useEffect(() => { load() }, [load]);

      const doArchive = async () => {
        setBusy("archive"); setMsg("");
        try {
          const r = await fetch(`${API}/diary/archive`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ keepDays: 1 }) });
          const j = await r.json();
          const done = (j.results ?? []).filter((x) => x.archived);
          setMsg(done.length ? `✓ 归档 ${done.length} 天：` + done.map((x) => `${x.day}（摘出 ${x.entries} 条）`).join("、") : "✓ 没有需要归档的（昨天已经归过）");
          await load();
        } catch (e) { setMsg("✗ " + e.message) } finally { setBusy("") }
      };
      const doIndex = async () => {
        setBusy("index"); setMsg("");
        try {
          const r = await fetch(`${API}/diary/index`, { method: "POST", headers: { accept: "application/json" } });
          const j = await r.json();
          setMsg(j.ok ? `✓ 索引已重建（${j.rows?.length ?? 0} 个分类 / ${j.total ?? 0} 条）` : `✗ ${j.error ?? "失败"}`);
          await load();
        } catch (e) { setMsg("✗ " + e.message) } finally { setBusy("") }
      };
      const doRecall = async () => {
        if (!recallQ.trim()) return;
        setBusy("recall"); setHits([]); setMsg("");
        try {
          const r = await fetch(`${API}/diary/recall?q=${encodeURIComponent(recallQ.trim())}`, { headers: { accept: "application/json" } });
          const j = await r.json();
          setHits(j.hits ?? []);
          if (!(j.hits ?? []).length) setMsg("没有翻到相关的旧片段。");
        } catch (e) { setMsg("✗ " + e.message) } finally { setBusy("") }
      };

      if (!sum) return h("div", { className: "blw-hint" }, "读取日记…");
      const total = (sum.kinds ?? []).reduce((n, r) => n + r.count, 0);
      return h("div", null,
        h("div", { className: "blw-group" }, "日记与记录库"),
        h("div", { className: "blw-hint", style: { marginTop: "2px" } },
          `目录 ${sum.root} · 今天 ${sum.today} · ${(sum.kinds ?? []).length} 个分类 / ${total} 条记录`),
        h("table", { className: "blw-tbl" },
          h("thead", null, h("tr", null, h("th", null, "分类"), h("th", null, "条目"), h("th", null, "最近"))),
          h("tbody", null, (sum.kinds ?? []).length
            ? sum.kinds.map((k) => h("tr", { key: k.kind },
                h("td", null, k.kind, kinds.includes(k.kind) ? null : h("span", { className: "blw-badge" }, "不在列表")),
                h("td", null, String(k.count)), h("td", null, k.last || "—")))
            : h("tr", null, h("td", { colSpan: 3, className: "blw-hint" }, "还没有记录（归档昨天之后就会有了）")))),
        sum.archived?.length ? h("div", { className: "blw-hint", style: { marginTop: "6px" } },
          "最近归档：" + sum.archived.map((a) => `${a.day}（${a.entries} 条）`).join(" · ")) : null,
        h("div", { className: "blw-actions", style: { borderTop: "none", marginTop: "8px", paddingTop: "0" } },
          h("button", { className: "blw-btn blw-btn2", onClick: doArchive, disabled: !!busy }, busy === "archive" ? "归档中…" : "归档前一天（摘记录）"),
          h("button", { className: "blw-btn blw-btn2", onClick: doIndex, disabled: !!busy }, busy === "index" ? "重建中…" : "重建总索引")),
        h("div", { className: "blw-row" },
          h("div", null, h("div", { className: "blw-label" }, "翻旧账"), h("div", { className: "blw-hint" }, "在 archive/ 的旧日记里找关键词（不常翻，所以平时不读）")),
          h("div", { style: { display: "flex", gap: "6px" } },
            h("input", { className: "blw-input", placeholder: "关键词，例如：显卡", value: recallQ, onChange: (e) => setRecallQ(e.target.value) }),
            h("button", { className: "blw-btn blw-btn2", onClick: doRecall, disabled: !!busy }, "找"))),
        hits.length ? h("div", { className: "blw-out" }, hits.map((x) => `${x.day}  ${x.file}\n  ${x.snippet}`).join("\n\n")) : null,
        msg ? h("div", { className: msg.startsWith("✓") ? "blw-hint" : "blw-err" }, msg) : null);
    }

    // ── 账本 ────────────────────────────────────────────────────────────────
    function LedgerPanel() {
      const [data, setData] = useState(null);
      const [open, setOpen] = useState(null);
      const [msg, setMsg] = useState("");
      const [busy, setBusy] = useState("");

      const load = useCallback(async () => {
        try {
          const r = await fetch(`${API}/ledger?n=6`, { headers: { accept: "application/json" } });
          const j = await r.json(); if (j.ok) setData(j);
        } catch { /* offline */ }
      }, []);
      useEffect(() => { load() }, [load]);

      const verify = async () => {
        setBusy("verify"); setMsg("");
        try {
          const r = await fetch(`${API}/ledger/verify`, { method: "POST", headers: { accept: "application/json" } });
          const j = await r.json();
          setMsg(j.ok ? `✓ 哈希链完整：${j.count} 份账从 GENESIS 一路对得上` : `❌ ${j.broken?.length ?? 0} 处断裂：` + (j.broken ?? []).map((b) => `${b.day}/${b.name}`).join("、"));
          await load();
        } catch (e) { setMsg("✗ " + e.message) } finally { setBusy("") }
      };
      const showFile = async (row) => {
        setBusy("file" + row.name);
        try {
          const r = await fetch(`${API}/ledger/file?name=${encodeURIComponent(row.day + "/" + row.name)}`, { headers: { accept: "application/json" } });
          const j = await r.json();
          setOpen(j.ok ? { name: row.name, text: j.text } : { name: row.name, text: j.error ?? "读不到" });
        } catch (e) { setOpen({ name: row.name, text: "✗ " + e.message }) } finally { setBusy("") }
      };

      if (!data) return h("div", { className: "blw-hint" }, "读取账本…");
      const rows = data.rows ?? [];
      return h("div", null,
        h("div", { className: "blw-group" }, "账本（哈希链）"),
        h("div", { className: "blw-hint", style: { marginTop: "2px" } },
          `${data.root} · ${data.chain?.count ?? 0} 份账 · ` + (data.chain?.ok ? "链是完整的 ✓" : "⚠️ 链有断裂")),
        rows.length ? h("table", { className: "blw-tbl" },
          h("thead", null, h("tr", null, h("th", null, "时间"), h("th", null, "类型"), h("th", null, "标题"))),
          h("tbody", null, rows.slice().reverse().map((r) => h("tr", { key: r.day + r.name, style: { cursor: "pointer" }, onClick: () => showFile(r) },
            h("td", { className: "blw-mono" }, r.day.slice(5) + " " + String(r.name).slice(0, 5)),
            h("td", null, r.meta?.mode ?? ""),
            h("td", null, r.meta?.title ?? ""))))) : h("div", { className: "blw-hint" }, "还没有账 —— 第一轮醒来之后会有了。"),
        open ? h("div", null,
          h("div", { className: "blw-hint", style: { marginTop: "8px" } }, `=== ${open.name}（点标题展开 / 再点表格换一份）`),
          h("div", { className: "blw-out" }, open.text)) : null,
        h("div", { className: "blw-actions", style: { borderTop: "none", marginTop: "8px", paddingTop: "0" } },
          h("button", { className: "blw-btn blw-btn2", onClick: verify, disabled: !!busy }, busy === "verify" ? "校验中…" : "校验哈希链"),
          h("button", { className: "blw-btn blw-btn2", onClick: load }, "刷新")),
        msg ? h("div", { className: msg.startsWith("✓") ? "blw-hint" : "blw-err" }, msg) : null);
    }

    // ── 扩展（mod）─────────────────────────────────────────────────────────
    function ExtensionsPanel({ onReload }) {
      const [data, setData] = useState(null);
      const [msg, setMsg] = useState("");
      const [busy, setBusy] = useState("");

      const load = useCallback(async () => {
        try {
          const r = await fetch(`${API}/extensions`, { headers: { accept: "application/json" } });
          const j = await r.json(); if (j.ok) setData(j);
        } catch { /* offline */ }
      }, []);
      useEffect(() => { load() }, [load]);

      const reload = async () => {
        setBusy("reload"); setMsg("");
        try {
          const r = await fetch(`${API}/extensions/reload`, { method: "POST", headers: { accept: "application/json" } });
          const j = await r.json();
          setMsg(j.ok ? `✓ 已重载 ${(j.list ?? []).length} 个扩展` : `✗ ${j.error ?? "失败"}`);
          await load(); onReload?.();
        } catch (e) { setMsg("✗ " + e.message) } finally { setBusy("") }
      };
      const toggle = async (id, enabled) => {
        setBusy("t" + id);
        try {
          const r = await fetch(`${API}/extensions/toggle`, {
            method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ id, enabled }),
          });
          const j = await r.json();
          if (!j.ok) setMsg(`✗ ${j.error ?? "失败"}`);
          await load();
        } catch (e) { setMsg("✗ " + e.message) } finally { setBusy("") }
      };

      if (!data) return h("div", { className: "blw-hint" }, "读取扩展…");
      const list = data.list ?? [];
      return h("div", null,
        h("div", { className: "blw-group" }, "mod 扩展"),
        h("div", { className: "blw-hint", style: { marginTop: "2px" } },
          `API v${data.apiVersion} · 事件：${(data.events ?? []).join(" / ")}`),
        h("div", { className: "blw-hint" }, `目录：${(data.dirs ?? []).join(" · ") || "（无）"}`),
        list.length ? h("table", { className: "blw-tbl" },
          h("thead", null, h("tr", null, h("th", null, "扩展"), h("th", null, "版本"), h("th", null, "启用"))),
          h("tbody", null, list.map((e) => h("tr", { key: e.id },
            h("td", null,
              e.name || e.id,
              h("div", { className: "blw-hint" }, `${e.id} · ${e.source}`),
              e.lastError ? h("div", { className: "blw-err" }, `⚠️ ${e.lastError}`) : null,
              h("div", { className: "blw-hint" }, `提示段 ${e.promptSections} · 字段 ${e.fields} · 命令 ${(e.commands ?? []).join(",") || "无"}`)),
            h("td", null, "v" + e.version),
            h("td", null, h("input", { type: "checkbox", checked: e.enabled !== false, disabled: !!busy,
              onChange: (ev) => toggle(e.id, ev.target.checked) })))))) 
          : h("div", { className: "blw-hint" }, "一个扩展都没有。把 .mjs 放进 ~/.dsh/pod-ext 或插件自带 extensions/ 目录，然后点重载。"),
        h("div", { className: "blw-actions", style: { borderTop: "none", marginTop: "8px", paddingTop: "0" } },
          h("button", { className: "blw-btn blw-btn2", onClick: reload, disabled: !!busy }, busy === "reload" ? "重载中…" : "重载扩展")),
        msg ? h("div", { className: msg.startsWith("✓") ? "blw-hint" : "blw-err" }, msg) : null);
    }

    // ── 状态（只读）─────────────────────────────────────────────────────────
    function StatusPanel() {
      const [st, setSt] = useState(null);
      const load = useCallback(async () => {
        try { const r = await fetch(`${API}/status`, { headers: { accept: "application/json" } }); const j = await r.json(); if (j.ok) setSt(j) } catch { /* offline */ }
      }, []);
      useEffect(() => { load() }, [load]);
      if (!st) return h("div", { className: "blw-hint" }, "读取状态…");
      const p = st.plan;
      const lines = [
        `生物钟：${st.scheduler?.ok ? "✓ 运行中" : "✗ " + (st.scheduler?.reason ?? "没起来")}（${st.scheduler?.at ?? ""}）`,
        p ? `今天计划：${p.action === "done" ? "已经跑完" : (p.atText ? `${p.atText} 左右醒来` : "待定")} · 已醒 ${p.wakes} 次 · 窗口 ${(p.windows ?? []).join("、") || "—"}` : "今天还没有计划（下一分钟会排）",
        `作息：${st.tide?.mode === "tide" ? "峰谷" : st.tide?.mode === "cheap" ? "低价时段" : "固定窗口"}${st.tide?.text ? " · " + st.tide.text : ""}${st.cheap?.text ? " · " + st.cheap.text : ""}`,
        ...(st.mistress?.enabled ? [`女主人：${st.mistress.name || "（未填昵称）"}（mid ${st.mistress.mid}）· 今天已给她 ${st.mistress.sentToday}/${st.mistress.shareDaily} 条`] : []),
        ...(st.taste ? [`口味：${(st.taste.like ?? []).length} 个喜欢 / ${(st.taste.dislike ?? []).length} 个不爱看 · 自改${st.taste.selfAdjust ? "开" : "关"} · 感兴趣学习${st.taste.learnFromInterest ? "开" : "关"}`] : []),
        `今天：发言 ${st.commentsToday} 条（分享 ${st.shares}/${st.sharesMax}）· 待复核 ${st.sentBatches} 条（已确认可见 ${st.sentVerified}）· 回过 ${st.repliedPeople} 人`,
        `日记：${(st.diary?.kinds ?? []).length} 个分类 · 最近归档 ${st.diary?.lastArchive || "—"}`,
        `账本：${st.ledger?.ok ? "✓ 完整" : "⚠️ 断裂"} · ${st.ledger?.count ?? 0} 份 · ${(st.ledger?.last ?? []).map((r) => r.title).join(" | ") || "—"}`,
        `权限单：${st.scope ? `${st.scope.reason || "—"}（写 ${st.scope.write?.join(",") || "无"}）` : "无（手动 / 已过期）"}`,
        `产出物：${st.artifacts?.enabled ? "开 · " + st.artifacts.dir : "关（默认）"}`,
        ...(st.spend && !st.spend.error ? [`开销：今天 ${st.spend.rounds} 轮 · ${((st.spend.tokens ?? 0) / 1e6).toFixed(2)}M tokens` + (st.spend.yuan != null ? ` ≈¥${st.spend.yuan.toFixed(3)}` : "") + (st.spend.topActivity ? ` · 最费：${st.spend.topActivity.label}` : "")] : []),
      ];
      return h("div", null,
        h("div", { className: "blw-group" }, "状态"),
        h("div", { className: "blw-out" }, lines.join("\n")),
        h("div", { className: "blw-actions", style: { borderTop: "none", marginTop: "6px", paddingTop: "0" } },
          h("button", { className: "blw-btn blw-btn2", onClick: load }, "刷新")));
    }

    // 开销面板（2026-10-22 主人要求）：她一天里哪件事最费 token。
    //   数据是宿主的 /spend 路由算好的（只读会话日志），前端只负责把它排出来。
    function SpendPanel() {
      const today = new Date().toLocaleDateString("sv-SE");
      const [date, setDate] = useState(today);
      const [rep, setRep] = useState(null);
      const [lines, setLines] = useState([]);
      const [busy, setBusy] = useState(false);
      const load = useCallback(async (d) => {
        setBusy(true);
        try {
          const r = await fetch(`${API}/spend?date=${encodeURIComponent(d || today)}`, { headers: { accept: "application/json" } });
          const j = await r.json();
          if (j.ok) { setRep(j.report); setLines(j.lines ?? []) }
          else setLines(["读不到开销：" + (j.error ?? "未知错误")]);
        } catch (e) { setLines(["读不到开销：" + e.message]) } finally { setBusy(false) }
      }, [today]);
      useEffect(() => { load(today) }, [load, today]);
      const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("sv-SE");
      return h("div", null,
        h("div", { className: "blw-group" }, "开销（花掉多少 token）"),
        h("div", { className: "blw-hint" }, "统计的是小鲸鱼自己的会话：每轮醒来的输入/缓存/输出 token，以及“为决定某件事付出的 token”估算。缓存读最便宜，输出最贵 —— 所以贵的不是她看了多少，而是她想了多少。"),
        h("div", { className: "blw-actions", style: { borderTop: "none", paddingTop: "0" } },
          h("button", { className: "blw-btn blw-btn2", onClick: () => { setDate(today); load(today) } }, "今天"),
          h("button", { className: "blw-btn blw-btn2", onClick: () => { setDate(yesterday); load(yesterday) } }, "昨天"),
          h("input", { className: "blw-input blw-mono", style: { width: "130px" }, type: "date", value: date, onChange: (e) => { setDate(e.target.value); load(e.target.value) } }),
          h("button", { className: "blw-btn blw-btn2", onClick: () => load(date), disabled: busy }, busy ? "读取中…" : "刷新")),
        h("div", { className: "blw-out blw-mono", style: { maxHeight: "320px", overflow: "auto", fontSize: "12px" } }, (lines.length ? lines : ["（没有数据）"]).join("\n")),
        rep ? h("div", { className: "blw-hint" }, `今日合计 ${((rep.usage?.totalTokens ?? 0) / 1e6).toFixed(2)}M tokens · ${rep.rounds} 轮` + (rep.yuan != null ? ` · ≈¥${rep.yuan.toFixed(3)}` : "") + (rep.byKind?.[0] ? ` · 最费：${rep.byKind[0].kindLabel}` : "")) : null);
    }

    function BiliPodSection() {
      useStyleOnce();
      const [cfg, setCfg] = useState(null);
      const [savedJson, setSavedJson] = useState("");
      const [out, setOut] = useState("");
      const [err, setErr] = useState("");
      const [busy, setBusy] = useState("");
      const [meta, setMeta] = useState(null);           // /settings 里的非 config 部分
      const [personaText, setPersonaText] = useState("");
      const [personaMsg, setPersonaMsg] = useState("");
      const [personaBytes, setPersonaBytes] = useState(0);
      const [tidePreview, setTidePreview] = useState([]);
      const [tideText, setTideText] = useState("");
      const [extValues, setExtValues] = useState({});

      const load = useCallback(async () => {
        setErr("");
        try {
          const r = await fetch(`${API}/settings`, { headers: { accept: "application/json" } });
          if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 403 ? "（被信任栅栏拒绝）" : ""}`);
          const j = await r.json();
          setCfg(j.config ?? {});
          setSavedJson(JSON.stringify(j.config ?? {}));
          setMeta(j);
          setTidePreview(j.tide?.preview ?? []);
          setTideText(j.tide?.text ?? "");
          setExtValues((prev) => {
            const next = { ...prev };
            for (const f of j.extensionFields ?? []) {
              // path 可能是数组（老版本宿主）也可能是点号字符串 —— 两种都接住
              const dotted = Array.isArray(f.path) ? f.path.join(".") : String(f.path ?? "");
              if (!dotted) continue;
              next[dotted] = getPath(j.config ?? {}, Array.isArray(f.path) ? f.path : dotted.split("."));
            }
            return next;
          });
          try {
            const pr = await fetch(`${API}/persona`, { headers: { accept: "application/json" } });
            if (pr.ok) { const pj = await pr.json(); setPersonaText(pj.text ?? ""); setPersonaBytes(pj.bytes ?? 0); }
          } catch { /* ignore */ }
        } catch (e) { setErr(`读取配置失败：${e.message}`); }
      }, []);

      useEffect(() => { load(); }, [load]);

      const set = (path, value) => setCfg((c) => {
        const next = JSON.parse(JSON.stringify(c ?? {}));
        setPath(next, path, value);
        return next;
      });

      const save = async () => {
        setBusy("save"); setErr(""); setOut("");
        try {
          const wins = cfg?.night?.windows ?? [];
          const total = Math.max(1, wins.reduce((s, w) => s + (Number(w.wakes) || 1), 0));
          const body = { ...(cfg ?? {}), night: { ...(cfg?.night ?? {}), maxWakesPerDay: total } };
          const r = await fetch(`${API}/settings`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ config: body, extensionValues: extValues }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          setOut(`✓ 已保存${(j.warns ?? []).length ? "\n⚠️ " + j.warns.join("\n⚠️ ") : ""}\n配置：${meta?.configPath ?? "~/.dsh/pod.config.json"}`);
          if (j.config) { setCfg(j.config); setSavedJson(JSON.stringify(j.config)); }
          if (j.tide) { setTidePreview(j.tide.preview ?? []); setTideText(j.tide.text ?? ""); }
        } catch (e) { setErr(`保存失败：${e.message}`); } finally { setBusy(""); }
      };

      const injectPersona = async () => {
        setBusy("persona"); setPersonaMsg("");
        try {
          const r = await fetch(`${API}/persona`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ text: personaText }),
          });
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
          setPersonaBytes(j.bytes ?? 0);
          setPersonaMsg(j.detail ?? "✓ 已注入");
        } catch (e) { setPersonaMsg("✗ " + e.message); }
        finally { setBusy(""); }
      };

      const deps = async () => {
        setBusy("deps"); setErr(""); setOut("检查中…");
        try {
          const r = await fetch(`${API}/deps`, { headers: { accept: "application/json" } });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          const lines = (j.items ?? []).map((i) => `${i.ok ? "✓" : "✗"} ${i.name} — ${i.detail ?? ""}`);
          if (j.self) lines.push("", `她自己：${j.self.name}（mid ${j.self.mid}）✓`);
          await load();
          setOut([...lines, "", j.ok ? "全部可用 ✓" : "有项不可用 ✗"].join("\n"));
        } catch (e) { setErr(`依赖体检失败：${e.message}`); } finally { setBusy(""); }
      };

      const previewTide = async () => {
        setBusy("tide"); setErr("");
        try {
          const r = await fetch(`${API}/tide/preview`, {
            method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ night: cfg?.night ?? {} }),
          });
          const j = await r.json();
          if (j.ok) { setTidePreview(j.preview ?? []); setTideText(j.text ?? ""); }
        } catch (e) { setErr("✗ " + e.message) } finally { setBusy("") }
      };

      if (!cfg) {
        return h("div", { className: "blw" },
          h("h3", { className: "blw-title" }, "鲸群"),
          err ? h("div", { className: "blw-err" }, err) : h("div", { className: "blw-hint" }, "读取中…"));
      }

      const groups = [];
      for (const f of FIELDS) {
        let g = groups.find((x) => x.name === f.group);
        if (!g) { g = { name: f.group, fields: [] }; groups.push(g); }
        g.fields.push(f);
      }

      const personaBlock = () => [
        h("div", { className: "blw-group", key: "persona-title" }, "她的人设（只属于她）"),
        h("div", { className: "blw-rows", key: "persona-rows" },
          h("div", { className: "blw-row" },
            h("div", null,
              h("div", { className: "blw-label" }, "人设正文"),
              h("div", { className: "blw-hint" },
                "写到 ", h("code", null, "~/.bili-ai/persona.md"),
                "，只影响她（不影响别的会话 ✓）。每次唤醒/监听都会附在提示里 ✓",
                h("br"),
                "建议写：身份与来历 / 说话腔调 / 在意什么、怕什么 / 明确不要的行为。上限 20000 字，注入时只取前 3000 字 ✓")),
            h("div", { className: "blw-cookie", style: { minWidth: "420px" } },
              h("textarea", {
                className: "blw-input",
                rows: 12,
                placeholder: "例如：\n她的名字是…\n她说话时会…\n她在意…\n她绝对不会…",
                value: personaText,
                onChange: (e) => setPersonaText(e.target.value),
                style: { resize: "vertical", fontFamily: "inherit", lineHeight: "1.6" },
              }),
              h("div", { className: "blw-hint" },
                "当前 " + personaBytes + " 字节" + (personaText.length > 20000 ? "（超过 20000 上限 ✗）" : "")),
              h("button", { className: "blw-btn", onClick: injectPersona, disabled: !!busy || personaText.length > 20000 },
                busy === "persona" ? "注入中…" : "注入人设"),
              personaMsg ? h("div", { className: personaMsg.startsWith("✓") ? "blw-hint" : "blw-err" }, personaMsg) : null))),
      ];

      // 作息：模式开关 + 固定窗口 / 峰谷 / DeepSeek 低价时段
      const scheduleBlock = () => {
        const mode = ["tide", "cheap"].includes(cfg.night?.mode) ? cfg.night.mode : "fixed";
        const cheap = cfg.night?.cheap ?? {};
        const cheapWins = Array.isArray(cheap.windows) && cheap.windows.length ? cheap.windows : [{ start: "00:30", end: "08:30" }];
        const nowInCheap = (() => { const m = new Date().getHours() * 60 + new Date().getMinutes(); return cheapWins.some((w) => { const [sh, sm] = String(w.start).split(":").map(Number), [eh, em] = String(w.end).split(":").map(Number); let s = sh * 60 + sm, e = eh * 60 + em; if (e <= s) e += 1440; return (m >= s && m < e) || (m + 1440 >= s && m + 1440 < e); }); })();
        return h("div", null,
          h("div", { className: "blw-group" }, "作息"),
          h("div", { className: "blw-rows" },
            h("div", { className: "blw-row" },
              h("div", null,
                h("div", { className: "blw-label" }, "生物钟"),
                h("div", { className: "blw-hint" }, "固定窗口 = 你给时段；峰谷 = 自己划峰/谷；低价时段 = 只在 DeepSeek 打折的钟点干活（省钱）")),
              h("div", null,
                h("label", { style: { display: "inline-flex", alignItems: "center", gap: "6px", marginRight: "14px", cursor: "pointer" } },
                  h("input", { type: "radio", name: "blw-night-mode", checked: mode === "fixed", onChange: () => set(["night", "mode"], "fixed") }), "固定窗口"),
                h("label", { style: { display: "inline-flex", alignItems: "center", gap: "6px", marginRight: "14px", cursor: "pointer" } },
                  h("input", { type: "radio", name: "blw-night-mode", checked: mode === "tide", onChange: () => set(["night", "mode"], "tide") }), "峰谷"),
                h("label", { style: { display: "inline-flex", alignItems: "center", gap: "6px", cursor: "pointer" } },
                  h("input", { type: "radio", name: "blw-night-mode", checked: mode === "cheap", onChange: () => set(["night", "mode"], "cheap") }), "低价时段"))),
            mode === "fixed" ? h(Row, { f: { path: ["night", "skipChance"], label: "今晚不看的概率", hint: "0.3 = 三成", kind: "number" }, cfg, set }) : null,
            h(Row, { f: { path: ["night", "maxVideos"], label: "单次醒来观看视频数量", hint: "初筛的候选数；筛完再挑 2–3 条深读", kind: "number" }, cfg, set }),
            mode === "fixed"
              ? h(WindowsEditor, { cfg, set })
              : mode === "tide"
                ? h(TideEditor, { cfg, set, onPreview: previewTide, preview: tidePreview, previewText: tideText })
                : h("div", null,
                    h("div", { className: "blw-hint", style: { margin: "6px 0" } },
                      "DeepSeek 折扣窗口固定在北京时间 00:30–08:30；" + (nowInCheap ? "现在正是低价时段 ✓" : "现在不是低价时段，她会在窗口内挑时间醒")),
                    cheapWins.map((w, i) => h("div", { className: "blw-row", key: "cheap-" + i },
                      h("div", null, h("div", { className: "blw-label" }, "低价窗口 " + (i + 1)),
                        h("div", { className: "blw-hint" }, "跨零点用 24:00 / 00:30 这种写法")),
                      h("div", { className: "blw-wins" },
                        h("input", { className: "blw-input blw-time", value: w.start ?? "00:30", onChange: (e) => set(["night", "cheap", "windows", String(i), "start"], e.target.value) }),
                        h("span", { className: "blw-tilde" }, "–"),
                        h("input", { className: "blw-input blw-time", value: w.end ?? "08:30", onChange: (e) => set(["night", "cheap", "windows", String(i), "end"], e.target.value) })))),
                    h("div", { className: "blw-row" },
                      h("div", null, h("div", { className: "blw-label" }, "窗口里醒几次"),
                        h("div", { className: "blw-hint" }, "2 = 一次半夜、一次天亮前")),
                      h("input", { className: "blw-input blw-num", type: "number", min: 1, max: 6, value: cheap.wakes ?? 2, onChange: (e) => set(["night", "cheap", "wakes"], Number(e.target.value)) })),
                    h("div", { className: "blw-row" },
                      h("div", null, h("div", { className: "blw-label" }, "到时候不看她的概率"),
                        h("div", { className: "blw-hint" }, "0.15 = 一成半；低价时段本来就该少花 token")),
                      h("input", { className: "blw-input blw-num", type: "number", min: 0, max: 0.95, step: 0.05, value: cheap.skipChance ?? 0.15, onChange: (e) => set(["night", "cheap", "skipChance"], Number(e.target.value)) })),
                    h("div", { className: "blw-group", style: { marginTop: "14px" } }, "其他时间的自定义窗口"),
                    h("div", { className: "blw-hint", style: { margin: "4px 0 8px" } },
                      "低价窗口之外，她照这些自定义时段干活（不填就只在低价窗口里醒）。"),
                    h(WindowsEditor, { cfg, set }))));
      };

      const renderGroup = (g) => {
        if (g.name === "作息") return h("div", { key: "作息" }, scheduleBlock());
        return h("div", { key: g.name },
          h("div", { className: "blw-group" }, g.name),
          h("div", { className: "blw-rows" }, g.fields.map((f) => h(Row, { key: f.path.join("."), f, cfg, set }))),
          g.name === "她是谁" ? h("div", null, personaBlock()) : null);
      };

      const extFields = (meta?.extensionFields ?? []);
      const extBlock = extFields.length
        ? h("div", null,
            h("div", { className: "blw-group" }, "扩展设置"),
            h("div", { className: "blw-rows" }, extFields.map((f) => h("div", { className: "blw-row", key: f.path },
              h("div", null,
                h("div", { className: "blw-label" }, f.label ?? f.path, h("span", { className: "blw-badge" }, f.ext ?? "ext")),
                f.hint ? h("div", { className: "blw-hint" }, f.hint) : null),
              f.kind === "switch"
                ? h("input", { type: "checkbox", checked: !!extValues[f.path], onChange: (e) => setExtValues((v) => ({ ...v, [f.path]: e.target.checked })) })
                : f.kind === "select"
                  ? h("select", { className: "blw-select", value: extValues[f.path] ?? "", onChange: (e) => setExtValues((v) => ({ ...v, [f.path]: e.target.value })) },
                      (f.options ?? []).map((o) => h("option", { key: o, value: o }, o)))
                  : h("input", { className: "blw-input", value: extValues[f.path] ?? "", onChange: (e) => setExtValues((v) => ({ ...v, [f.path]: e.target.value })) })))))
        : null;

      const preReview = String(cfg.review?.policy ?? "auto-quiet") !== "off";

      return h("div", { className: "blw" },
        h("h3", { className: "blw-title" }, "鲸群"),
        h("p", { className: "blw-intro" },
          "让 agent 自己按作息刷 B 站、看懂视频、写日记、记记录、落账本，把值得的 @ 你。",
          "所有值写进 ", h("code", null, meta?.configPath ?? "~/.dsh/pod.config.json"),
          "（与工具链共用同一份 ✓；这里没显示的字段保存时原样保留 ✓）。"),

        h(LoginPanel, { credentials: meta?.credentials, onSaved: load }),

        ...groups.filter((g) => ["她是谁", "你（主人）", "口味"].includes(g.name)).map(renderGroup),
        ...groups.filter((g) => g.name === "女主人").map(renderGroup),
        h(ShareEditor, { cfg, set }),
        h(ListenEditor, { cfg, set }),

        scheduleBlock(),
        ...groups.filter((g) => g.name === "审核与复核").map(renderGroup),
        h(PendingEditor, { preReview }),

        ...groups.filter((g) => g.name === "日记").map(renderGroup),
        h(DiaryPanel, { kinds: cfg.diary?.records ?? [] }),

        ...groups.filter((g) => g.name === "账本").map(renderGroup),
        h(LedgerPanel),

        ...groups.filter((g) => g.name === "产出物").map(renderGroup),
        ...groups.filter((g) => g.name === "写权限").map(renderGroup),
        ...groups.filter((g) => g.name === "扩展").map(renderGroup),
        extBlock,
        h(ExtensionsPanel, { onReload: load }),

        h(NotifyEditor, { cfg, set, save }),
        ...groups.filter((g) => g.name === "工具链").map(renderGroup),

        h(StatusPanel),
        h(SpendPanel),

        h("div", { className: "blw-actions" },
          h("button", { className: "blw-btn", onClick: save, disabled: !!busy }, busy === "save" ? "保存中…" : "保存"),
          cfg && savedJson && JSON.stringify(cfg) !== savedJson
            ? h("span", { style: { marginLeft: "10px", color: "#ffb020", fontSize: "13px" } }, "● 有改动还没保存（改了不点保存 = 没生效 ✗）")
            : null,
          h("button", { className: "blw-btn blw-btn2", onClick: deps, disabled: !!busy }, busy === "deps" ? "体检中…" : "依赖体检"),
          h("button", {
            className: "blw-btn blw-btn2",
            disabled: !!busy,
            onClick: async () => {
              const ok = typeof window === "undefined" ? true : window.confirm("现在就叫她起来？会立刻按「醒来」流程跑一轮（算今天的一次）。");
              if (!ok) return;
              setBusy("wake");
              setErr(""); setOut("");
              try {
                const r = await fetch(`${API}/wake-now`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: "{}" });
                const j = await r.json();
                setOut(j.ok ? "✓ 已经叫醒她，看看「状态」和日记。" : `✗ ${j.reason || j.detail || "叫不醒"}`);
                await load();
              } catch (e) { setErr(String(e?.message || e)) } finally { setBusy("") }
            },
          }, busy === "wake" ? "叫醒中…" : "现在叫她起来"),
          h("button", { className: "blw-btn blw-btn2", onClick: load, disabled: !!busy }, "重新读取")),

        err ? h("div", { className: "blw-err" }, err) : null,
        out ? h("div", { className: "blw-out" }, out) : null,
        h("div", { className: "blw-hint" }, "装完先点「依赖体检」：cookie / ffmpeg / node / 数据目录 都 ✓ 才算可用；扫码登录只需要扫一次。"));
    }

    const inject = ["slots"];
    const NS = "bili-pod";
    const NAMES = { nav: "鲸群" };

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              { name: "settings.section", id: NS, order: 6, label: () => NAMES.nav },
              BiliPodSection,
            ),
            "bili-pod: settings section",
          ),
        "bili-pod: settings section",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.BiliPodSection = BiliPodSection;
    exports.FIELDS = FIELDS;
    exports.createLoginFlow = createLoginFlow;
    return module.exports;
  },
});
