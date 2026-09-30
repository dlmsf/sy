import Config from "./Config/Config.js";
import SyAPP from "../SyAPP.js";
import SyDB from "../SyDB.js";
import SyPM from '../SyPM.js'
import fs from 'fs'

class SyInstances {
  static Model = SyDB.Model('SyInstances', {
    Name: { required: true, type: 'string', default: 'Draft' },
    Main: { required: true, type: 'boolean', default: true },
    OwnerID: { required: false, type: 'string' },
    Type: { required: false },
    Running: { required: true, type: 'boolean', default: true },
    Status: { required: true, type: 'string', default: 'Online' },
    ProcessId: { required: false, type: 'string', default: null },
    ProcessType: { required: false, type: 'string', default: null },
    ProcessSource: { required: false, type: 'string', default: null }
  });
}

// ================================================================
// SyLink — ACID process-link manager
// ================================================================
// Every SyInstance-linked SyPM process is named "sy-<instance._id>".
// That deterministic name is the ACID key: the process can always be
// located and killed by name, regardless of what ProcessId says.
//
// Invariants enforced continuously:
//   I1. No orphan process: every live "sy-<id>" process MUST have a
//       matching SyInstance. Violations are killed immediately.
//   I2. No dead reference: every instance.ProcessId MUST be live.
//       Dead refs are cleared; live processes under the expected name
//       are adopted (repairs drift after external restarts).
//   I3. Kill before delete: any instance deletion kills its linked
//       process(es) BEFORE the DB row is removed.
//
// Two enforcement layers:
//   • reconcile() — full DB↔SyPM reconciliation (kills orphans,
//                   clears dead refs, adopts live processes).
//   • reaper()    — prunes dead entries from the SyPM registry
//                   itself, so --list never shows zombie rows.
// ================================================================
class SyLink {
  static PREFIX = 'sy-';

  /** Deterministic SyPM process name for an instance. */
  static nameFor(instance) {
    if (!instance || instance._id === undefined || instance._id === null) return null;
    return `${SyLink.PREFIX}${instance._id}`;
  }

  /** Instance id encoded in a sy-<id> process name, or null. */
  static ownerOf(procName) {
    if (typeof procName !== 'string' || !procName.startsWith(SyLink.PREFIX)) return null;
    return procName.slice(SyLink.PREFIX.length);
  }

  /** Safe registry read — never throws. */
  static _registry() {
    try { return SyPM._loadRegistry() || []; } catch (_) { return []; }
  }

  /** Safe aliveness check — never throws. */
  static alive(processId) {
    if (!processId) return false;
    try { return SyPM.isAlive(processId); } catch (_) { return false; }
  }

  /** Safe kill — never throws. */
  static kill(processId) {
    if (!processId) return false;
    try { SyPM.kill(processId); return true; } catch (_) { return false; }
  }

  /**
   * Kill every SyPM process linked to an instance, using BOTH the
   * recorded ProcessId AND the deterministic name. Belt-and-braces:
   * a stale ProcessId can never leave an orphan behind.
   * @returns {number} number of process ids killed
   */
  static killForInstance(instance) {
    if (!instance) return 0;
    const killed = new Set();

    // 1) Tracked ProcessId
    if (instance.ProcessId && SyLink.alive(instance.ProcessId)) {
      if (SyLink.kill(instance.ProcessId)) killed.add(instance.ProcessId);
    }

    // 2) Deterministic name (catches drift, duplicates, stale refs)
    const expected = SyLink.nameFor(instance);
    if (expected) {
      for (const p of SyLink._registry()) {
        if (p.name !== expected) continue;
        if (SyLink.alive(p.id) && SyLink.kill(p.id)) killed.add(p.id);
      }
    }

    return killed.size;
  }

  /**
   * Kill every SyPM process whose sy-<id> owner is in `ids`.
   * Used after deletion as a final backstop.
   * @returns {number} number of process ids killed
   */
  static killForIds(ids) {
    const wanted = new Set(Array.from(ids, String));
    const killed = new Set();
    for (const p of SyLink._registry()) {
      const owner = SyLink.ownerOf(p.name);
      if (owner === null || !wanted.has(owner)) continue;
      if (SyLink.alive(p.id) && SyLink.kill(p.id)) killed.add(p.id);
    }
    return killed.size;
  }

  /**
   * Prune dead entries from the SyPM registry itself.
   * @returns {number} number of dead entries pruned
   */
  static reaper() {
    let deadBefore = 0;
    try {
      const before = SyLink._registry();
      deadBefore = before.filter(p => !SyLink.alive(p.id)).length;
      if (deadBefore === 0) return 0;
      SyPM.cleanup();
    } catch (_) { /* ignore */ }
    return deadBefore;
  }

  /**
   * Full DB↔SyPM reconciliation. MUST be awaited.
   * @param {Array} allInstances — current DB snapshot
   * @returns {{killedOrphans:number, clearedRefs:number, adoptedRefs:number, repairedRefs:number, reaped:number}}
   */
  static async reconcile(allInstances) {
    const stats = { killedOrphans: 0, clearedRefs: 0, adoptedRefs: 0, repairedRefs: 0, reaped: 0 };
    const validIds = new Set(allInstances.map(i => String(i._id)));

    const liveByName = new Map();
    for (const p of SyLink._registry()) {
      const owner = SyLink.ownerOf(p.name);
      if (owner === null) continue;

      // I1: orphan — owner instance no longer exists → kill now
      if (!validIds.has(owner)) {
        if (SyLink.alive(p.id) && SyLink.kill(p.id)) stats.killedOrphans++;
        continue;
      }

      if (!liveByName.has(owner) && SyLink.alive(p.id)) {
        liveByName.set(owner, p);
      } else if (liveByName.has(owner)) {
        // Duplicate name for the same owner → kill the extra
        if (SyLink.alive(p.id) && SyLink.kill(p.id)) stats.killedOrphans++;
      }
    }

    // I2: reconcile each instance's ProcessId
    for (const inst of allInstances) {
      const tracked = inst.ProcessId;
      const trackedAlive = tracked ? SyLink.alive(tracked) : false;
      const expected = liveByName.get(String(inst._id));

      if (tracked && !trackedAlive) {
        if (expected) {
          try {
            await SyInstances.Model.update(inst._id, {
              ProcessId: expected.id, Running: true, Status: 'Online'
            });
            stats.adoptedRefs++;
          } catch (_) { /* ignore */ }
        } else {
          try {
            await SyInstances.Model.update(inst._id, {
              ProcessId: null, Running: false, Status: 'Offline'
            });
            stats.clearedRefs++;
          } catch (_) { /* ignore */ }
        }
        continue;
      }

      if (!tracked && expected) {
        try {
          await SyInstances.Model.update(inst._id, {
            ProcessId: expected.id, Running: true, Status: 'Online'
          });
          stats.adoptedRefs++;
        } catch (_) { /* ignore */ }
      }

      if (tracked && trackedAlive && expected && tracked !== expected.id) {
        try {
          await SyInstances.Model.update(inst._id, { ProcessId: expected.id });
          stats.repairedRefs++;
        } catch (_) { /* ignore */ }
      }
    }

    stats.reaped = SyLink.reaper();
    return stats;
  }
}

class Sy extends SyAPP.Func() {
  constructor() {
    super(
      'sy',
      async (props) => {
        const uid = props.session.UniqueID;
        let page = props.page || '';

        let instances = await SyInstances.Model.find();

        // ---------- PERSISTENT STATE HELPERS ----------
        const getManageState = () => {
          const state = this.Storages.Get(uid, 'manage_state');
          return state || {
            action: null,
            confirmDeleteId: null,
            targetInstanceId: null,
            editTargetId: null,
            processView: null,
            // Daemon is pre-selected BEFORE the process is started, so
            // the very first spawn already goes through the init system
            // when the user wants it. Reset to false whenever the user
            // leaves the process view.
            pendingDaemon: false
          };
        };

        const setManageState = (updates) => {
          const current = getManageState();
          const newState = { ...current, ...updates };
          this.Storages.Set(uid, 'manage_state', newState);
          return newState;
        };

        const getBulkState = () => {
          const state = this.Storages.Get(uid, 'bulk_state');
          return state || { selectedIds: [] };
        };

        const setBulkState = (updates) => {
          const current = getBulkState();
          const newState = { ...current, ...updates };
          this.Storages.Set(uid, 'bulk_state', newState);
          return newState;
        };

        // ---------- PROCESS LINK (SyLink / SyPM) ----------
        const getProcessInfo = (processId) => {
          if (!processId) return null;
          try {
            return SyLink._registry().find(p => p.id === processId) || null;
          } catch (e) {
            return null;
          }
        };

        const getProcessAlive = (processId) => SyLink.alive(processId);

        const getProcessStatusLabel = (instance) => {
          if (!instance || !instance.ProcessId) return '';
          return getProcessAlive(instance.ProcessId) ? '  ONLINE' : '  OFFLINE';
        };

        // Spawn a linked process. `options.daemon` selects whether the
        // very first spawn goes through the init system (systemd /
        // OpenRC) so the process is boot-persistent and managed by the
        // service manager from the start — no detach-then-convert.
        const startProcessFromInstance = (instance, options = {}) => {
          if (!instance || !instance.ProcessSource) return null;
          const type = instance.ProcessType || 'file';
          const source = instance.ProcessSource;
          const name = SyLink.nameFor(instance);
          const opts = {
            name,
            autoRestart: true,
            restartTries: 5,
            daemon: !!options.daemon
          };
          try {
            if (type === 'file')    return SyPM.run(source, opts);
            if (type === 'code')    return SyPM.run(source, opts);
            if (type === 'command') return SyPM.exec(source, opts);
            if (type === 'flow') {
              const flowFile = path.join(os.tmpdir(), `sy_flow_${instance._id}_${Date.now()}.sh`);
              fs.writeFileSync(flowFile, '#!/bin/bash\nset -e\n' + source, 'utf-8');
              fs.chmodSync(flowFile, 0o755);
              return SyPM.exec(`bash "${flowFile}"`, opts);
            }
          } catch (e) {
            return null;
          }
          return null;
        };

        const stopLinkedProcess = (instance) => SyLink.killForInstance(instance) > 0;

        // ---------- CONTINUOUS ACID REAPER ----------
        // Runs at most once per ACID_SWEEP_MS per session, on every
        // render tick. Full DB↔SyPM reconciliation + registry pruning.
        const ACID_SWEEP_MS = 1500;
        const _lastSweep = Number(this.Storages.Get(uid, 'acid_last_sweep') || 0);
        if (Date.now() - _lastSweep > ACID_SWEEP_MS) {
          this.Storages.Set(uid, 'acid_last_sweep', Date.now());
          try {
            const stats = await SyLink.reconcile(instances);
            if (stats.killedOrphans || stats.clearedRefs || stats.adoptedRefs || stats.repairedRefs) {
              instances = await SyInstances.Model.find();
            }
          } catch (e) {
            console.error('[SyLink reaper]', e && e.message);
          }
        }

        // ---------- HELPER: Get all descendants of an instance ----------
        const getAllDescendants = (instanceId, allInstances) => {
          const descendants = [];
          const collectDescendants = (id) => {
            for (const inst of allInstances) {
              if (inst.OwnerID === id) {
                descendants.push(inst._id);
                collectDescendants(inst._id);
              }
            }
          };
          collectDescendants(instanceId);
          return descendants;
        };

        // ---------- HELPER: Delete instance and all descendants ----------
        // ACID order: kill → grace → DB delete → final sweep.
        const deleteInstanceAndDescendants = async (instanceId, allInstances) => {
          const descendants = getAllDescendants(instanceId, allInstances);
          const idsToDelete = [instanceId, ...descendants];

          let killedTotal = 0;
          for (const id of idsToDelete) {
            const inst = allInstances.find(i => String(i._id) === String(id));
            if (inst) killedTotal += SyLink.killForInstance(inst);
          }

          if (killedTotal > 0) {
            await new Promise(r => setTimeout(r, 250));
          }

          for (const descId of descendants) {
            await SyInstances.Model.delete(descId);
          }
          await SyInstances.Model.delete(instanceId);

          const leftover = SyLink.killForIds(idsToDelete);
          if (killedTotal + leftover > 0) {
            console.log(`[Sy ACID] Deleted instance ${instanceId}: killed ${killedTotal + leftover} linked process(es)`);
          }
        };

        // ---------- SYNC TARGET INSTANCE ID WITH PROPS (for manage page) ----------
        // When entering manage page with a specific target, store it persistently.
        if (page === 'manage' && props.target_instance) {
          const currentState = getManageState();
          if (currentState.targetInstanceId !== props.target_instance) {
            setManageState({ targetInstanceId: props.target_instance });
          }
        }

        // ---------- CREATE NEW INSTANCE ----------
        if (props.new_instance) {
          await SyInstances.Model.create({
            Name: 'Draft',
            Main: props.parent_id ? false : true,
            OwnerID: props.parent_id || null,
            Type: props.parent_id ? 'child' : 'app',
            Running: true,
            Status: 'Online'
          });
        }

        // ---------- DELETE INSTANCE (DIRECT - AFTER CONFIRMATION) ----------
        if (props.do_delete) {
          await deleteInstanceAndDescendants(props.do_delete, instances);

          // Reset manage state completely and return to main page
          setManageState({
            action: null,
            confirmDeleteId: null,
            targetInstanceId: null,
            editTargetId: null
          });
          setBulkState({ selectedIds: [] });

          // Force navigation back to main page
          this.SetPage(uid, '');
          page = '';

          // Re-fetch instances so the main page reflects the deletion immediately
          instances = await SyInstances.Model.find();
        }

        // ---------- BULK DELETE INSTANCES ----------
        if (props.bulk_delete) {
          const bulkState = getBulkState();
          const selectedIds = [...bulkState.selectedIds];

          for (const id of selectedIds) {
            await deleteInstanceAndDescendants(id, instances);
          }

          // Reset bulk and manage state
          setBulkState({ selectedIds: [] });
          setManageState({
            action: null,
            confirmDeleteId: null,
            targetInstanceId: null,
            editTargetId: null
          });

          // Force navigation back to main page
          this.SetPage(uid, '');
        }

        // ---------- DIRECT EDIT NAME (FROM MANAGE BUTTON) ----------
        if (props.edit_name) {
          if (props.inputValue) {
            await SyInstances.Model.update(props.edit_name, { Name: props.inputValue.trim() });
            setManageState({ action: null, confirmDeleteId: null, targetInstanceId: null, editTargetId: null });
            this.SetPage(uid, '');
            page = '';

            // Re-fetch instances so the main page reflects the new name immediately
            instances = await SyInstances.Model.find();
          } else {
            this.WaitInput(uid, { question: 'New name:', props: { edit_name: props.edit_name, page: 'manage', target_instance: props.target_instance } });
          }
        }

        // ---------- BULK EDIT NAME ----------
        if (props.bulk_edit_name) {
          if (props.inputValue) {
            const bulkState = getBulkState();
            const selectedIds = [...bulkState.selectedIds];

            if (selectedIds.length === 1) {
              // If only one selected, use exact name
              await SyInstances.Model.update(selectedIds[0], { Name: props.inputValue.trim() });
            } else {
              // If multiple selected, add suffix
              for (let i = 0; i < selectedIds.length; i++) {
                const id = selectedIds[i];
                await SyInstances.Model.update(id, { Name: `${props.inputValue.trim()}_${i + 1}` });
              }
            }

            setBulkState({ selectedIds: [] });
            setManageState({ action: null, confirmDeleteId: null, targetInstanceId: null, editTargetId: null });
            this.SetPage(uid, '');
          } else {
            this.WaitInput(uid, { question: 'New base name for selected:', props: { bulk_edit_name: true, page: 'manage', target_instance: props.target_instance } });
          }
        }

        // ---------- MANAGE ACTION HANDLERS ----------
        if (props.manage_action === 'edit') {
          // Direct edit - immediately ask for new name for the target instance
          const targetId = props.target_instance || getManageState().targetInstanceId;
          if (targetId) {
            this.WaitInput(uid, {
              question: 'New name:',
              props: { edit_name: targetId, page: 'manage', target_instance: targetId }
            });
          }
        }

        if (props.manage_action === 'delete') {
          // Direct delete - immediately show confirmation for the target instance
          const targetId = props.target_instance || getManageState().targetInstanceId;
          if (targetId) {
            setManageState({
              action: 'delete',
              confirmDeleteId: targetId,
              targetInstanceId: null,
              editTargetId: null
            });
          }
        }

        if (props.manage_action === 'bulk') {
          setManageState({ action: 'bulk', confirmDeleteId: null, targetInstanceId: props.target_instance || null, editTargetId: null });
        }

        if (props.manage_action === 'bulk_confirm') {
          setManageState({ action: 'bulk_confirm', confirmDeleteId: null, targetInstanceId: props.target_instance || null, editTargetId: null });
        }

        if (props.manage_action === 'process') {
          setManageState({ action: null, confirmDeleteId: null, processView: 'menu' });
        }

        if (props.manage_action === 'back') {
          setManageState({
            action: null,
            confirmDeleteId: null,
            targetInstanceId: null,
            editTargetId: null,
            processView: null,
            pendingDaemon: false
          });
          setBulkState({ selectedIds: [] });
        }

        // Toggle the daemon flag in the *setup* views (before start).
        // This is read by every commit_* handler so the very first
        // spawn already goes through the init system when enabled.
        // NOTE: this handler does NOT need targetInstance — it only
        // flips a pending preference stored on manage_state.
        if (props.process_toggle_pending_daemon) {
          const cur = getManageState();
          setManageState({ pendingDaemon: !cur.pendingDaemon });
        }

        // ---------- BULK SELECTION HANDLERS ----------
        if (props.toggle_select) {
          const bulkState = getBulkState();
          const selectedIds = [...bulkState.selectedIds];
          const index = selectedIds.indexOf(props.toggle_select);

          if (index === -1) {
            selectedIds.push(props.toggle_select);
          } else {
            selectedIds.splice(index, 1);
          }

          setBulkState({ selectedIds });
        }

        if (props.clear_selection) {
          setBulkState({ selectedIds: [] });
        }

        // ---------- HELPERS ----------
        const isDropdownOpen = (key) => {
          const state = this.Storages.Get(uid, `dropdown-${key}`);
          return state && state.dropped === true;
        };

        const getVisibleInstances = (allInstances) => {
          const visible = [];
          const mains = allInstances.filter(i => i.Main === true);

          // Find which main is open (only one main layer can be open)
          let openMain = null;
          for (const main of mains) {
            if (isDropdownOpen(`inst-${main._id}`)) {
              openMain = main;
              break;
            }
          }

          const traverse = (instance, depth, parentOpen) => {
            if (!parentOpen) return;
            visible.push({ instance, depth });
            const ownOpen = isDropdownOpen(`inst-${instance._id}`);
            const children = allInstances.filter(i => i.OwnerID === instance._id);
            for (const child of children) {
              traverse(child, depth + 1, ownOpen);
            }
          };

          // Only traverse children of the open main
          if (openMain) {
            const children = allInstances.filter(i => i.OwnerID === openMain._id);
            for (const child of children) {
              traverse(child, 1, true);
            }
          }

          return visible;
        };

        // ---------- CLOSE OTHER MAIN DROPDOWNS ----------
        const closeOtherMainDropdowns = (currentMainId) => {
          const mains = instances.filter(i => i.Main === true);
          for (const main of mains) {
            if (main._id !== currentMainId) {
              const key = `dropdown-inst-${main._id}`;
              const state = this.Storages.Get(uid, key);
              if (state && state.dropped) {
                state.dropped = false;
                this.Storages.Set(uid, key, state);
              }
            }
          }
        };

        // ---------- CLOSE ALL CHILD DROPDOWNS OF A PARENT ----------
        const closeChildDropdowns = (parentId) => {
          const descendants = getAllDescendants(parentId, instances);
          for (const descId of descendants) {
            const key = `dropdown-inst-${descId}`;
            const state = this.Storages.Get(uid, key);
            if (state && state.dropped) {
              state.dropped = false;
              this.Storages.Set(uid, key, state);
            }
          }
        };

        // ---------- RENDER INSTANCE TREE (CLEAN) ----------
        const renderInstance = async (instance, depth = 0, isMain = false) => {
          const children = instances.filter(i => i.OwnerID === instance._id);
          const key = `inst-${instance._id}`;
          const count = children.length ? ` (${children.length})` : '';
          const prefix = isMain ? '' : '    '.repeat(depth) + '└─ ';
          const statusSuffix = getProcessStatusLabel(instance);

          // Capture state before DropDown for main close detection
          const stateBefore = this.Storages.Get(uid, `dropdown-${key}`);
          const wasOpenBefore = stateBefore?.dropped === true;
          const wasClicked = props.droprun === `dropdown-${key}`;

          // If this is a main instance and was clicked to open, close other main dropdowns
          if (isMain && wasClicked) {
            const currentState = this.Storages.Get(uid, `dropdown-${key}`);
            if (currentState && !currentState.dropped) {
              closeOtherMainDropdowns(instance._id);
            }
          }

          await this.DropDown(uid, key, async () => {
            // Calculate indentation for buttons based on depth
            const buttonIndent = '  '.repeat(depth + 1);

            // Group Add Child and Manage buttons horizontally with extra indentation
            this.Buttons(uid, [
              {
                name: this.TextColor.orange(`${buttonIndent}＋ Add Child`),
                props: { new_instance: true, parent_id: instance._id, page }
              },
              {
                name: this.TextColor.orange(`${buttonIndent}⚙️ Manage`),
                props: { page: 'manage', target_instance: instance._id }
              }
            ]);

            // Recursively render children
            for (const child of children) {
              await renderInstance(child, depth + 1, false);
            }
          }, {
            up_buttontext: `${prefix}📁 ${instance.Name}${count}${statusSuffix}`,
            down_buttontext: `${prefix}📂 ${instance.Name}${count}${statusSuffix}`,
            jumpTo: 0
          });

          // After DropDown, check if main was open and now closed -> close children
          const stateAfter = this.Storages.Get(uid, `dropdown-${key}`);
          const isNowClosed = stateAfter?.dropped === false;
          if (isMain && wasOpenBefore && isNowClosed) {
            closeChildDropdowns(instance._id);
          }
        };

        // ---------- RENDER MAIN PAGE ----------
        await this.Page(uid, '', async () => {
          const mains = instances.filter(i => i.Main === true);
          for (const main of mains) {
            await renderInstance(main, 0, true);
          }

        
          await this.PinnedBottom(uid, async () => {
            this.Button(uid, {
              name: this.TextColor.orange('＋ New'),
              props: { new_instance: true, page }
            });

            this.Button(uid, ' ');
            this.SideButton(uid, { name: '⚙️ Config', path: 'config' });
          },{separator : 'none'});
        });

        // ---------- RENDER MANAGE PAGE ----------
        await this.Page(uid, 'manage', async () => {
          let manageState = getManageState();
          let bulkState = getBulkState();

          // Determine target instance (use persistent state first, then prop)
          let targetInstanceId = manageState.targetInstanceId || props.target_instance;
          let targetInstance = targetInstanceId
            ? instances.find(i => i._id === targetInstanceId)
            : null;

          // ---------- PROCESS ACTION HANDLERS ----------
          if (props.process_action && targetInstance) {
            const _pa = props.process_action;
            const _proc = getProcessInfo(targetInstance.ProcessId);
            const _procAlive = _proc ? getProcessAlive(_proc.id) : false;

            if (_pa === 'back') {
              setManageState({ processView: null, pendingDaemon: false });
            } else if (_pa === 'link_file') {
              setManageState({ processView: 'link_file' });
            } else if (_pa === 'link_code') {
              setManageState({ processView: 'link_code' });
            } else if (_pa === 'link_command') {
              setManageState({ processView: 'link_command' });
            } else if (_pa === 'link_flow') {
              setManageState({ processView: 'link_flow' });
            } else if (_pa === 'view_logs') {
              setManageState({ processView: 'logs' });
            } else if (_pa === 'edit_source') {
              const _t = targetInstance.ProcessType || 'file';
              if (_t === 'file') setManageState({ processView: 'link_file' });
              else if (_t === 'code') setManageState({ processView: 'link_code' });
              else if (_t === 'command') setManageState({ processView: 'link_command' });
              else if (_t === 'flow') setManageState({ processView: 'link_flow' });
            } else if (_pa === 'unlink') {
              stopLinkedProcess(targetInstance);
              await SyInstances.Model.update(targetInstance._id, { ProcessId: null, ProcessType: null, ProcessSource: null });
              instances = await SyInstances.Model.find();
              targetInstance = instances.find(i => i._id === targetInstanceId);
              setManageState({ processView: 'menu', pendingDaemon: false });
            } else if (_pa === 'stop') {
              stopLinkedProcess(targetInstance);
              await SyInstances.Model.update(targetInstance._id, { Running: false, Status: 'Offline' });
              instances = await SyInstances.Model.find();
              targetInstance = instances.find(i => i._id === targetInstanceId);
            } else if (_pa === 'start') {
              // Honor the pre-selected daemon flag from the setup view.
              const _wantDaemon = !!getManageState().pendingDaemon;
              const _new = startProcessFromInstance(targetInstance, { daemon: _wantDaemon });
              if (_new) {
                await SyInstances.Model.update(targetInstance._id, { ProcessId: _new.id, Running: true, Status: 'Online' });
                instances = await SyInstances.Model.find();
                targetInstance = instances.find(i => i._id === targetInstanceId);
                setManageState({ pendingDaemon: false });
              } else {
                this.Alert(uid, 'Failed to start process.', { duration: 3000 });
              }
            } else if (_pa === 'restart') {
              // Preserve the daemon flag across restarts.
              const _wantDaemon = !!(_proc && _proc.config && _proc.config.daemon);
              if (_procAlive) {
                stopLinkedProcess(targetInstance);
                await new Promise(r => setTimeout(r, 300));
                const _new = startProcessFromInstance(targetInstance, { daemon: _wantDaemon });
                if (_new) {
                  await SyInstances.Model.update(targetInstance._id, {
                    ProcessId: _new.id, Running: true, Status: 'Online'
                  });
                } else {
                  await SyInstances.Model.update(targetInstance._id, {
                    ProcessId: null, Running: false, Status: 'Offline'
                  });
                }
              } else {
                const _new = startProcessFromInstance(targetInstance, { daemon: _wantDaemon });
                if (_new) {
                  await SyInstances.Model.update(targetInstance._id, { ProcessId: _new.id, Running: true, Status: 'Online' });
                }
              }
              instances = await SyInstances.Model.find();
              targetInstance = instances.find(i => i._id === targetInstanceId);
            } else if (_pa === 'toggle_daemon') {
              // Daemon conversion is NOT a flag flip. The running
              // detached process must be fully killed and re-spawned
              // through the init system, otherwise the old unmanaged
              // tree keeps running and systemd/OpenRC has nothing to
              // attach to. Full kill → grace → re-spawn with the new
              // daemon flag. The same approach works in both directions
              // (ON → OFF tears down the service and re-spawns detached).
              const _wasDaemon = !!(_proc && _proc.config && _proc.config.daemon);
              const _wantDaemon = !_wasDaemon;
              try {
                stopLinkedProcess(targetInstance);
                await new Promise(r => setTimeout(r, 300));

                const _new = startProcessFromInstance(targetInstance, { daemon: _wantDaemon });
                if (_new) {
                  await SyInstances.Model.update(targetInstance._id, {
                    ProcessId: _new.id, Running: true, Status: 'Online'
                  });
                  this.Alert(uid,
                    `Daemon ${_wantDaemon ? 'enabled' : 'disabled'} — process restarted.`,
                    { duration: 3000 });
                } else {
                  await SyInstances.Model.update(targetInstance._id, {
                    ProcessId: null, Running: false, Status: 'Offline'
                  });
                  this.Alert(uid, 'Daemon toggle: failed to restart process.', { duration: 3000 });
                }
              } catch (e) {
                this.Alert(uid, `Daemon toggle failed: ${e.message}`, { duration: 3000 });
              }
              instances = await SyInstances.Model.find();
              targetInstance = instances.find(i => i._id === targetInstanceId);
            } else if (_pa === 'commit_file') {
              const _sel = this.FileManager.GetSelected(uid, `proc_file_${targetInstance._id}`);
              if (_sel.length > 0) {
                const _wantDaemon = !!getManageState().pendingDaemon;
                try {
                  stopLinkedProcess(targetInstance);
                  await new Promise(r => setTimeout(r, 200));
                  const _new = SyPM.run(_sel[0], {
                    name: SyLink.nameFor(targetInstance),
                    autoRestart: true, restartTries: 5, daemon: _wantDaemon
                  });
                  await SyInstances.Model.update(targetInstance._id, {
                    ProcessId: _new.id, ProcessType: 'file', ProcessSource: _sel[0], Running: true, Status: 'Online'
                  });
                  this.FileManager.ClearSelection(uid, `proc_file_${targetInstance._id}`);
                  setManageState({ processView: 'menu', pendingDaemon: false });
                  instances = await SyInstances.Model.find();
                  targetInstance = instances.find(i => i._id === targetInstanceId);
                } catch (e) {
                  this.Alert(uid, `Failed to start: ${e.message}`, { duration: 3000 });
                }
              }
            } else if (_pa === 'commit_code') {
              const _code = this.Storages.Get(uid, `texteditor_proc_code_${targetInstance._id}`) || '';
              if (_code.trim()) {
                const _wantDaemon = !!getManageState().pendingDaemon;
                try {
                  stopLinkedProcess(targetInstance);
                  await new Promise(r => setTimeout(r, 200));
                  const _new = SyPM.run(_code, {
                    name: SyLink.nameFor(targetInstance),
                    autoRestart: true, restartTries: 5, daemon: _wantDaemon
                  });
                  await SyInstances.Model.update(targetInstance._id, {
                    ProcessId: _new.id, ProcessType: 'code', ProcessSource: _code, Running: true, Status: 'Online'
                  });
                  setManageState({ processView: 'menu', pendingDaemon: false });
                  instances = await SyInstances.Model.find();
                  targetInstance = instances.find(i => i._id === targetInstanceId);
                } catch (e) {
                  this.Alert(uid, `Failed to start: ${e.message}`, { duration: 3000 });
                }
              }
            } else if (_pa === 'commit_command') {
              const _cmd = this.Storages.Get(uid, `field_proc_cmd_${targetInstance._id}`) || '';
              if (_cmd.trim()) {
                const _wantDaemon = !!getManageState().pendingDaemon;
                try {
                  stopLinkedProcess(targetInstance);
                  await new Promise(r => setTimeout(r, 200));
                  const _new = SyPM.exec(_cmd, {
                    name: SyLink.nameFor(targetInstance),
                    autoRestart: true, restartTries: 5, daemon: _wantDaemon
                  });
                  await SyInstances.Model.update(targetInstance._id, {
                    ProcessId: _new.id, ProcessType: 'command', ProcessSource: _cmd, Running: true, Status: 'Online'
                  });
                  setManageState({ processView: 'menu', pendingDaemon: false });
                  instances = await SyInstances.Model.find();
                  targetInstance = instances.find(i => i._id === targetInstanceId);
                } catch (e) {
                  this.Alert(uid, `Failed to start: ${e.message}`, { duration: 3000 });
                }
              }
            } else if (_pa === 'commit_flow') {
              const _flow = this.Storages.Get(uid, `texteditor_proc_flow_${targetInstance._id}`) || '';
              if (_flow.trim()) {
                const _wantDaemon = !!getManageState().pendingDaemon;
                try {
                  stopLinkedProcess(targetInstance);
                  await new Promise(r => setTimeout(r, 200));
                  const _flowFile = path.join(os.tmpdir(), `sy_flow_${targetInstance._id}_${Date.now()}.sh`);
                  fs.writeFileSync(_flowFile, '#!/bin/bash\nset -e\n' + _flow, 'utf-8');
                  fs.chmodSync(_flowFile, 0o755);
                  const _new = SyPM.exec(`bash "${_flowFile}"`, {
                    name: SyLink.nameFor(targetInstance),
                    autoRestart: true, restartTries: 5, daemon: _wantDaemon
                  });
                  await SyInstances.Model.update(targetInstance._id, {
                    ProcessId: _new.id, ProcessType: 'flow', ProcessSource: _flow, Running: true, Status: 'Online'
                  });
                  setManageState({ processView: 'menu', pendingDaemon: false });
                  instances = await SyInstances.Model.find();
                  targetInstance = instances.find(i => i._id === targetInstanceId);
                } catch (e) {
                  this.Alert(uid, `Failed to start flow: ${e.message}`, { duration: 3000 });
                }
              }
            }

            manageState = getManageState();
            bulkState = getBulkState();
          }

          // Get visible instances based on target or all mains
          let visible = [];
          if (targetInstance) {
            // Show target instance and its children
            visible.push({ instance: targetInstance, depth: 0 });
            const children = instances.filter(i => i.OwnerID === targetInstance._id);
            for (const child of children) {
              visible.push({ instance: child, depth: 1 });
            }
          } else {
            // Show all main instances and their children by default
            const mains = instances.filter(i => i.Main === true);
            for (const main of mains) {
              visible.push({ instance: main, depth: 0 });
              const children = instances.filter(i => i.OwnerID === main._id);
              for (const child of children) {
                visible.push({ instance: child, depth: 1 });
              }
            }
          }

          // Title
          this.Text(uid, '⚙️ Instance Management');
          this.Text(uid, '─'.repeat(40));

          // CONFIRMATION VIEW (Direct Delete)
          if (manageState.confirmDeleteId) {
            const target = instances.find(i => i._id === manageState.confirmDeleteId);
            const targetName = target ? target.Name : 'Unknown';
            const descendants = getAllDescendants(manageState.confirmDeleteId, instances);

            this.Text(uid, `Delete "${targetName}"?`);
            if (descendants.length > 0) {
              this.Text(uid, `This will also delete ${descendants.length} child instance(s).`);
            }
            this.Buttons(uid, [
              {
                name: '✅ Yes, Delete',
                props: { do_delete: manageState.confirmDeleteId, page: 'manage' }
              },
              {
                name: '❌ Cancel',
                props: { manage_action: 'back', page: 'manage' }
              }
            ]);
          }
          // BULK CONFIRMATION VIEW
          else if (manageState.action === 'bulk_confirm') {
            const bulkState = getBulkState();
            const selectedIds = bulkState.selectedIds;
            let totalDescendants = 0;

            for (const id of selectedIds) {
              totalDescendants += getAllDescendants(id, instances).length;
            }

            this.Text(uid, `Delete ${selectedIds.length} selected instances?`);
            if (totalDescendants > 0) {
              this.Text(uid, `This will also delete ${totalDescendants} child instance(s).`);
            }
            this.Buttons(uid, [
              {
                name: '✅ Yes, Delete All',
                props: { bulk_delete: true, page: 'manage' }
              },
              {
                name: '❌ Cancel',
                props: { manage_action: 'back', page: 'manage' }
              }
            ]);
          }
          // BULK SELECTION VIEW
          else if (manageState.action === 'bulk') {
            this.Text(uid, '🔲 Select multiple instances:');
            this.Text(uid, `Selected: ${bulkState.selectedIds.length}`);

            if (visible.length === 0) {
              this.Text(uid, 'No visible instances.');
            } else {
              for (const { instance, depth } of visible) {
                const indent = '　'.repeat(depth);
                const typeIcon = instance.Main ? '🟢' : '└─';
                const isSelected = bulkState.selectedIds.includes(instance._id);
                const checkbox = isSelected ? '☑️' : '☐';

                this.Button(uid, {
                  name: `${indent}${checkbox} ${typeIcon} ${instance.Name}`,
                  props: { toggle_select: instance._id, page: 'manage', target_instance: manageState.targetInstanceId }
                });
              }
            }

            this.Button(uid, ' ');

            // Bulk action buttons
            if (bulkState.selectedIds.length > 0) {
              this.Buttons(uid, [
                {
                  name: '✏️ Bulk Rename',
                  props: { bulk_edit_name: true, page: 'manage', target_instance: manageState.targetInstanceId }
                },
                {
                  name: '🗑️ Bulk Delete',
                  props: { manage_action: 'bulk_confirm', page: 'manage', target_instance: manageState.targetInstanceId }
                },
                {
                  name: '❌ Clear Selection',
                  props: { clear_selection: true, page: 'manage', target_instance: manageState.targetInstanceId }
                }
              ]);
            }

            this.Button(uid, ' ');
            this.Button(uid, {
              name: '↩ Back',
              props: { manage_action: 'back', page: 'manage' }
            });
          }
          // PROCESS MANAGER VIEW
          else if (manageState.processView) {
            const _proc = targetInstance ? getProcessInfo(targetInstance.ProcessId) : null;
            const _procAlive = _proc ? getProcessAlive(_proc.id) : false;
            const _daemonOn = _proc && _proc.config && _proc.config.daemon;
            const _pv = manageState.processView;

            this.Text(uid, '🔧 Process Manager');
            if (targetInstance) this.Text(uid, `Instance: ${targetInstance.Name}`);
            this.Text(uid, '─'.repeat(40));

            if (_pv === 'menu') {
              if (!targetInstance) {
                this.Text(uid, 'No target instance.');
              } else if (!targetInstance.ProcessId) {
                this.Text(uid, 'No process linked. Choose a method:');
                this.Button(uid, { name: '📄 From .js File', props: { process_action: 'link_file', page: 'manage', target_instance: targetInstance._id } });
                this.Button(uid, { name: '📝 Write Code', props: { process_action: 'link_code', page: 'manage', target_instance: targetInstance._id } });
                this.Button(uid, { name: '💻 Global Command', props: { process_action: 'link_command', page: 'manage', target_instance: targetInstance._id } });
                this.Button(uid, { name: '🔗 Command Flow', props: { process_action: 'link_flow', page: 'manage', target_instance: targetInstance._id } });
              } else {
                const statusText = _procAlive
                  ? this.TextColor.green('● ONLINE')
                  : this.TextColor.red('○ OFFLINE');
                this.Text(uid, `Status: ${statusText}`);
                this.Text(uid, `Type:   ${targetInstance.ProcessType || 'unknown'}`);

                if (_procAlive) {
                  this.Buttons(uid, [
                    { name: '⏹ Stop', props: { process_action: 'stop', page: 'manage', target_instance: targetInstance._id } },
                    { name: '🔄 Restart', props: { process_action: 'restart', page: 'manage', target_instance: targetInstance._id } }
                  ]);
                } else {
                  this.Buttons(uid, [
                    { name: '▶ Start', props: { process_action: 'start', page: 'manage', target_instance: targetInstance._id } },
                    { name: '🔄 Restart', props: { process_action: 'restart', page: 'manage', target_instance: targetInstance._id } }
                  ]);
                }

                this.Buttons(uid, [
                  { name: _daemonOn ? '🔧 Daemon: ON' : '🔧 Daemon: OFF', props: { process_action: 'toggle_daemon', page: 'manage', target_instance: targetInstance._id } },
                  { name: '📜 Logs', props: { process_action: 'view_logs', page: 'manage', target_instance: targetInstance._id } }
                ]);

                this.Buttons(uid, [
                  { name: '✏ Edit', props: { process_action: 'edit_source', page: 'manage', target_instance: targetInstance._id } },
                  { name: '🔓 Unlink', props: { process_action: 'unlink', page: 'manage', target_instance: targetInstance._id } }
                ]);
              }
            } else if (_pv === 'link_file') {
              this.Text(uid, 'Select a .js file to run as a process:');
              await this.File(uid, {
                name: `proc_file_${targetInstance._id}`,
                multiple: false,
                filter: (itemPath, isDir) => isDir || itemPath.toLowerCase().endsWith('.js'),
                startPath: os.homedir(),
                displayName: '📁 Select .js File',
                itemsPerPage: 8
              });
              // Daemon pre-select toggle — applies to the FIRST spawn.
              const _pd = !!getManageState().pendingDaemon;
              this.Button(uid, {
                name: _pd ? '🔧 Daemon on start: ON' : '🔧 Daemon on start: OFF',
                props: { process_toggle_pending_daemon: true, page: 'manage', target_instance: targetInstance._id }
              });
              const _sel = this.FileManager.GetSelected(uid, `proc_file_${targetInstance._id}`);
              if (_sel.length > 0) {
                this.Text(uid, `Selected: ${_sel[0]}`);
                this.Button(uid, { name: '✅ Link & Start', props: { process_action: 'commit_file', page: 'manage', target_instance: targetInstance._id } });
              }
            } else if (_pv === 'link_code') {
              this.Text(uid, 'Write Node.js code to run as a process:');
              await this.TextEditor(uid, `proc_code_${targetInstance._id}`, {
                label: 'Process Code',
                title: `Code: ${targetInstance.Name}`,
                initialValue: targetInstance.ProcessSource || '// Node.js code\nconsole.log("hello from process");\n'
              });
              // Daemon pre-select toggle — applies to the FIRST spawn.
              const _pd = !!getManageState().pendingDaemon;
              this.Button(uid, {
                name: _pd ? '🔧 Daemon on start: ON' : '🔧 Daemon on start: OFF',
                props: { process_toggle_pending_daemon: true, page: 'manage', target_instance: targetInstance._id }
              });
              this.Button(uid, { name: '✅ Save & Start', props: { process_action: 'commit_code', page: 'manage', target_instance: targetInstance._id } });
            } else if (_pv === 'link_command') {
              this.Text(uid, 'Enter a global command line:');
              this.Field(uid, `proc_cmd_${targetInstance._id}`, {
                label: 'Command',
                initialValue: targetInstance.ProcessSource || '',
                maxWidth: 60
              });
              // Daemon pre-select toggle — applies to the FIRST spawn.
              const _pd = !!getManageState().pendingDaemon;
              this.Button(uid, {
                name: _pd ? '🔧 Daemon on start: ON' : '🔧 Daemon on start: OFF',
                props: { process_toggle_pending_daemon: true, page: 'manage', target_instance: targetInstance._id }
              });
              this.Button(uid, { name: '✅ Save & Start', props: { process_action: 'commit_command', page: 'manage', target_instance: targetInstance._id } });
            } else if (_pv === 'link_flow') {
              this.Text(uid, 'Command flow — one command per line (runs sequentially):');
              await this.TextEditor(uid, `proc_flow_${targetInstance._id}`, {
                label: 'Command Flow',
                title: `Flow: ${targetInstance.Name}`,
                initialValue: targetInstance.ProcessSource || '#!/bin/bash\n# Example flow:\n# curl -o /tmp/script.sh https://example.com/script.sh\n# bash /tmp/script.sh\n'
              });
              // Daemon pre-select toggle — applies to the FIRST spawn.
              const _pd = !!getManageState().pendingDaemon;
              this.Button(uid, {
                name: _pd ? '🔧 Daemon on start: ON' : '🔧 Daemon on start: OFF',
                props: { process_toggle_pending_daemon: true, page: 'manage', target_instance: targetInstance._id }
              });
              this.Button(uid, { name: '✅ Save & Start', props: { process_action: 'commit_flow', page: 'manage', target_instance: targetInstance._id } });
            } else if (_pv === 'logs') {
              this.Text(uid, 'Log Output (last 60 lines):');
              this.Text(uid, '─'.repeat(40));
              if (_proc && _proc.log && fs.existsSync(_proc.log)) {
                try {
                  const _content = fs.readFileSync(_proc.log, 'utf-8');
                  const _lines = _content.split('\n').slice(-60);
                  for (const _line of _lines) {
                    this.Text(uid, _line);
                  }
                } catch (e) {
                  this.Text(uid, `Error reading log: ${e.message}`);
                }
              } else {
                this.Text(uid, 'No log file available.');
              }
            }

            this.Button(uid, ' ');
            this.Button(uid, {
              name: '↩ Back',
              props: { process_action: 'back', page: 'manage', target_instance: targetInstance ? targetInstance._id : undefined }
            });
          }
          // DEFAULT: ACTION SELECTION
          else {
            this.Text(uid, 'Instance Actions:');

            // Show the target instance name
            if (targetInstance) {
              this.Text(uid, `Target: ${targetInstance.Name}`);
            }

            this.Buttons(uid, [
              {
                name: '✏️ Rename',
                props: { manage_action: 'edit', page: 'manage', target_instance: targetInstanceId }
              },
              {
                name: '🗑️ Delete',
                props: { manage_action: 'delete', page: 'manage', target_instance: targetInstanceId }
              },
              {
                name: '🔧 Process',
                props: { manage_action: 'process', page: 'manage', target_instance: targetInstanceId }
              },
              {
                name: '🔲 Bulk',
                props: { manage_action: 'bulk', page: 'manage', target_instance: targetInstanceId }
              }
            ]);
          }

          // Back to main instances page
          this.Button(uid, ' ');
          this.Button(uid, {
            name: '↩ Back to Instances',
            props: { page: '' }
          });
        });
      },
      { linked: [Config],syappInit : async ({ mainFuncName, syapp, userConfig, sessions }) => {
        await SyDB.Connect(mainFuncName)

        // ---------- ACID BOOT SWEEP ----------
        // One-shot full reconciliation BEFORE the first screen renders.
        // Guarantees no orphan process and no stale ProcessId can
        // survive a restart, a crash, or a manual DB wipe. Also prunes
        // dead entries from the SyPM registry so --list starts clean.
        try {
          const instances = await SyInstances.Model.find();
          const stats = await SyLink.reconcile(instances);
          const total = stats.killedOrphans + stats.clearedRefs
                      + stats.adoptedRefs + stats.repairedRefs + stats.reaped;
          if (total > 0) {
            console.log(
              `[Sy ACID boot] killedOrphans=${stats.killedOrphans} ` +
              `clearedRefs=${stats.clearedRefs} adoptedRefs=${stats.adoptedRefs} ` +
              `repairedRefs=${stats.repairedRefs} reaped=${stats.reaped}`
            );
          }
        } catch (e) {
          console.error('[Sy ACID boot] sweep failed:', e && e.message);
        }
      } }
    );
  }
}

export default Sy;
