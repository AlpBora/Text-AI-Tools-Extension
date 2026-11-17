(function (root) {
  "use strict";

  const NS = (root.__TEXT_AI_TOOLS__ = root.__TEXT_AI_TOOLS__ || {});

  const DEFAULT_MAX_HISTORY = 50;

  function createUndoManager(options) {
    const maxHistory =
      options && typeof options.maxHistory === "number" && options.maxHistory > 0
        ? Math.floor(options.maxHistory)
        : DEFAULT_MAX_HISTORY;

    let seq = 0;
    const history = [];

    function recordAutoCorrect(entry) {
      if (!entry || typeof entry !== "object") {
        throw new TypeError("UndoManager.recordAutoCorrect requires an entry object");
      }
      const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : Date.now();
      seq += 1;
      const undoId = `undo_${seq}_${timestamp}`;

      const stored = {
        undoId,
        targetRef: entry.targetRef !== undefined ? entry.targetRef : null,
        start: typeof entry.start === "number" ? entry.start : 0,
        end: typeof entry.end === "number" ? entry.end : 0,
        originalWord: String(entry.originalWord ?? ""),
        correctedWord: String(entry.correctedWord ?? ""),
        timestamp,
      };

      history.push(stored);
      if (history.length > maxHistory) {
        history.splice(0, history.length - maxHistory);
      }

      return undoId;
    }

    function cloneEntry(entry) {
      return entry
        ? {
            undoId: entry.undoId,
            targetRef: entry.targetRef,
            start: entry.start,
            end: entry.end,
            originalWord: entry.originalWord,
            correctedWord: entry.correctedWord,
            timestamp: entry.timestamp,
          }
        : null;
    }

    function getLatest(targetRef) {
      if (history.length === 0) return null;
      if (targetRef === undefined) {
        return cloneEntry(history[history.length - 1]);
      }
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].targetRef === targetRef) {
          return cloneEntry(history[i]);
        }
      }
      return null;
    }

    function consume(undoId) {
      if (!undoId || typeof undoId !== "string") return null;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].undoId === undoId) {
          const [removed] = history.splice(i, 1);
          return cloneEntry(removed);
        }
      }
      return null;
    }

    function clear(targetRef) {
      if (targetRef === undefined) {
        history.length = 0;
        return;
      }
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].targetRef === targetRef) {
          history.splice(i, 1);
        }
      }
    }

    function size(targetRef) {
      if (targetRef === undefined) return history.length;
      let count = 0;
      for (let i = 0; i < history.length; i++) {
        if (history[i].targetRef === targetRef) count++;
      }
      return count;
    }

    return {
      recordAutoCorrect,
      getLatest,
      consume,
      clear,
      size,
    };
  }

  const UndoManager = createUndoManager();
  UndoManager.create = createUndoManager;

  NS.UndoManager = UndoManager;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = UndoManager;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);
