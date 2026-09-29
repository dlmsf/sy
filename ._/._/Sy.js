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
            processView: null
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

        // ---------- PROCESS LINK HELPERS (SyPM) ----------
        const getProcessInfo = (processId) => {
          if (!processId) return null;
          try {
            const registry = SyPM._loadRegistry();
            return registry.find(p => p.id === processId) || null;
          } catch (e) {
            return null;
          }
        };

        const getProcessAlive = (processId) => {
          if (!processId) return false;
          try {
            return SyPM.isAlive(processId);
          } catch (e) {
            return false;
          }
        };

        const getProcessStatusLabel = (instance) => {
          if (!instance || !instance.ProcessId) return '';
          return getProcessAlive(instance.ProcessId) ? '  ONLINE' : '  OFFLINE';
        };

        const startProcessFromInstance = (instance) => {
          if (!instance || !instance.ProcessSource) return null;
          const type = instance.ProcessType || 'file';
          const source = instance.ProcessSource;
          const name = `sy-${instance._id}`;
          try {
            if (type === 'file') {
              return SyPM.run(source, { name, autoRestart: true, restartTries: 5 });
            }
            if (type === 'code') {
              return SyPM.run(source, { name, autoRestart: true, restartTries: 5 });
            }
            if (type === 'command') {
              return SyPM.exec(source, { name, autoRestart: true, restartTries: 5 });
            }
            if (type === 'flow') {
              const flowFile = path.join(os.tmpdir(), `sy_flow_${instance._id}_${Date.now()}.sh`);
              fs.writeFileSync(flowFile, '#!/bin/bash\nset -e\n' + source, 'utf-8');
              fs.chmodSync(flowFile, 0o755);
              return SyPM.exec(`bash "${flowFile}"`, { name, autoRestart: true, restartTries: 5 });
            }
          } catch (e) {
            return null;
          }
          return null;
        };

        const stopLinkedProcess = (instance) => {
          if (!instance || !instance.ProcessId) return false;
          const proc = getProcessInfo(instance.ProcessId);
          if (proc && getProcessAlive(proc.id)) {
            try { SyPM.kill(proc.id); return true; } catch (e) { return false; }
          }
          return false;
        };

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
        const deleteInstanceAndDescendants = async (instanceId, allInstances) => {
          const descendants = getAllDescendants(instanceId, allInstances);

          // Delete all descendants first (children, grandchildren, etc.)
          for (const descId of descendants) {
            await SyInstances.Model.delete(descId);
          }

          // Finally delete the instance itself
          await SyInstances.Model.delete(instanceId);
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
          setManageState({ action: null, confirmDeleteId: null, targetInstanceId: null, editTargetId: null, processView: null });
          setBulkState({ selectedIds: [] });
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
              setManageState({ processView: null });
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
              setManageState({ processView: 'menu' });
            } else if (_pa === 'stop') {
              stopLinkedProcess(targetInstance);
              await SyInstances.Model.update(targetInstance._id, { Running: false, Status: 'Offline' });
              instances = await SyInstances.Model.find();
              targetInstance = instances.find(i => i._id === targetInstanceId);
            } else if (_pa === 'start') {
              const _new = startProcessFromInstance(targetInstance);
              if (_new) {
                await SyInstances.Model.update(targetInstance._id, { ProcessId: _new.id, Running: true, Status: 'Online' });
                instances = await SyInstances.Model.find();
                targetInstance = instances.find(i => i._id === targetInstanceId);
              } else {
                this.Alert(uid, 'Failed to start process.', { duration: 3000 });
              }
            } else if (_pa === 'restart') {
              if (_procAlive) {
                try { SyPM.restart(_proc.id); } catch (e) {}
              } else {
                const _new = startProcessFromInstance(targetInstance);
                if (_new) {
                  await SyInstances.Model.update(targetInstance._id, { ProcessId: _new.id, Running: true, Status: 'Online' });
                }
              }
              instances = await SyInstances.Model.find();
              targetInstance = instances.find(i => i._id === targetInstanceId);
            } else if (_pa === 'toggle_daemon') {
              if (_proc) {
                try {
                  if (_proc.config && _proc.config.daemon) {
                    SyPM.disableDaemon(_proc.id);
                  } else {
                    SyPM.enableDaemon(_proc.id);
                  }
                } catch (e) {
                  this.Alert(uid, `Daemon toggle failed: ${e.message}`, { duration: 3000 });
                }
              }
            } else if (_pa === 'commit_file') {
              const _sel = this.FileManager.GetSelected(uid, `proc_file_${targetInstance._id}`);
              if (_sel.length > 0) {
                try {
                  stopLinkedProcess(targetInstance);
                  const _new = SyPM.run(_sel[0], { name: `sy-${targetInstance._id}`, autoRestart: true, restartTries: 5 });
                  await SyInstances.Model.update(targetInstance._id, {
                    ProcessId: _new.id, ProcessType: 'file', ProcessSource: _sel[0], Running: true, Status: 'Online'
                  });
                  this.FileManager.ClearSelection(uid, `proc_file_${targetInstance._id}`);
                  setManageState({ processView: 'menu' });
                  instances = await SyInstances.Model.find();
                  targetInstance = instances.find(i => i._id === targetInstanceId);
                } catch (e) {
                  this.Alert(uid, `Failed to start: ${e.message}`, { duration: 3000 });
                }
              }
            } else if (_pa === 'commit_code') {
              const _code = this.Storages.Get(uid, `texteditor_proc_code_${targetInstance._id}`) || '';
              if (_code.trim()) {
                try {
                  stopLinkedProcess(targetInstance);
                  const _new = SyPM.run(_code, { name: `sy-${targetInstance._id}`, autoRestart: true, restartTries: 5 });
                  await SyInstances.Model.update(targetInstance._id, {
                    ProcessId: _new.id, ProcessType: 'code', ProcessSource: _code, Running: true, Status: 'Online'
                  });
                  setManageState({ processView: 'menu' });
                  instances = await SyInstances.Model.find();
                  targetInstance = instances.find(i => i._id === targetInstanceId);
                } catch (e) {
                  this.Alert(uid, `Failed to start: ${e.message}`, { duration: 3000 });
                }
              }
            } else if (_pa === 'commit_command') {
              const _cmd = this.Storages.Get(uid, `field_proc_cmd_${targetInstance._id}`) || '';
              if (_cmd.trim()) {
                try {
                  stopLinkedProcess(targetInstance);
                  const _new = SyPM.exec(_cmd, { name: `sy-${targetInstance._id}`, autoRestart: true, restartTries: 5 });
                  await SyInstances.Model.update(targetInstance._id, {
                    ProcessId: _new.id, ProcessType: 'command', ProcessSource: _cmd, Running: true, Status: 'Online'
                  });
                  setManageState({ processView: 'menu' });
                  instances = await SyInstances.Model.find();
                  targetInstance = instances.find(i => i._id === targetInstanceId);
                } catch (e) {
                  this.Alert(uid, `Failed to start: ${e.message}`, { duration: 3000 });
                }
              }
            } else if (_pa === 'commit_flow') {
              const _flow = this.Storages.Get(uid, `texteditor_proc_flow_${targetInstance._id}`) || '';
              if (_flow.trim()) {
                try {
                  stopLinkedProcess(targetInstance);
                  const _flowFile = path.join(os.tmpdir(), `sy_flow_${targetInstance._id}_${Date.now()}.sh`);
                  fs.writeFileSync(_flowFile, '#!/bin/bash\nset -e\n' + _flow, 'utf-8');
                  fs.chmodSync(_flowFile, 0o755);
                  const _new = SyPM.exec(`bash "${_flowFile}"`, { name: `sy-${targetInstance._id}`, autoRestart: true, restartTries: 5 });
                  await SyInstances.Model.update(targetInstance._id, {
                    ProcessId: _new.id, ProcessType: 'flow', ProcessSource: _flow, Running: true, Status: 'Online'
                  });
                  setManageState({ processView: 'menu' });
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
              this.Button(uid, { name: '✅ Save & Start', props: { process_action: 'commit_code', page: 'manage', target_instance: targetInstance._id } });
            } else if (_pv === 'link_command') {
              this.Text(uid, 'Enter a global command line:');
              this.Field(uid, `proc_cmd_${targetInstance._id}`, {
                label: 'Command',
                initialValue: targetInstance.ProcessSource || '',
                maxWidth: 60
              });
              this.Button(uid, { name: '✅ Save & Start', props: { process_action: 'commit_command', page: 'manage', target_instance: targetInstance._id } });
            } else if (_pv === 'link_flow') {
              this.Text(uid, 'Command flow — one command per line (runs sequentially):');
              await this.TextEditor(uid, `proc_flow_${targetInstance._id}`, {
                label: 'Command Flow',
                title: `Flow: ${targetInstance.Name}`,
                initialValue: targetInstance.ProcessSource || '#!/bin/bash\n# Example flow:\n# curl -o /tmp/script.sh https://example.com/script.sh\n# bash /tmp/script.sh\n'
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
      } }
    );
  }
}

export default Sy;
