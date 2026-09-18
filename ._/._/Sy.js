import Config from "./Config/Config.js";
import SyAPP from "../SyAPP.js";
import SyDB from "../SyDB.js";

class SyInstances {
  static Model = SyDB.Model('SyInstances', {
    Name: { required: true, type: 'string', default: 'Draft' },
    Main: { required: true, type: 'boolean', default: true },
    OwnerID: { required: false, type: 'string' },
    Type: { required: false },
    Running: { required: true, type: 'boolean', default: true },
    Status: { required: true, type: 'string', default: 'Online' }
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
            editTargetId: null
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

        if (props.manage_action === 'back') {
          setManageState({ action: null, confirmDeleteId: null, targetInstanceId: null, editTargetId: null });
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
          const prefix = isMain ? '🟢 ' : '    '.repeat(depth) + '└─ ';

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
            up_buttontext: `${prefix}📁 ${instance.Name}${count}`,
            down_buttontext: `${prefix}📂 ${instance.Name}${count}`,
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

          this.Button(uid, ' ');
          await this.PinnedBottom(uid, async () => {
            this.Button(uid, {
              name: this.TextColor.orange('＋ New'),
              props: { new_instance: true, page }
            });

            this.Button(uid, ' ');
            this.SideButton(uid, { name: '⚙️ Config', path: 'config' });
          });
        });

        // ---------- RENDER MANAGE PAGE ----------
        await this.Page(uid, 'manage', async () => {
          const manageState = getManageState();
          const bulkState = getBulkState();

          // Determine target instance (use persistent state first, then prop)
          const targetInstanceId = manageState.targetInstanceId || props.target_instance;
          const targetInstance = targetInstanceId
            ? instances.find(i => i._id === targetInstanceId)
            : null;

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
          // DEFAULT: ACTION SELECTION
          else {
            this.Text(uid, 'Instance Actions:');

            // Show the target instance name
            if (targetInstance) {
              this.Text(uid, `Target: ${targetInstance.Name}`);
            }

            this.Buttons(uid, [
              {
                name: '✏️ Rename This Instance',
                props: { manage_action: 'edit', page: 'manage', target_instance: targetInstanceId }
              },
              {
                name: '🗑️ Delete This Instance',
                props: { manage_action: 'delete', page: 'manage', target_instance: targetInstanceId }
              },
              {
                name: '🔲 Bulk Manage',
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
      { linked: [Config] }
    );
  }
}

export default Sy;