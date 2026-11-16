import SyAPP from '../../../SyAPP.js'
import SyDB from '../../../SyDB.js'
import executor from '../../._/Util/executor.js'

function formatObjectKeys(obj) {
    const keys = Object.keys(obj).filter(key => key !== '_id' && key !== '_created_at');
    const selectedKeys = keys.slice(0, 2);
    return selectedKeys.map(key => `${key}: ${obj[key]}`).join(', ');
}

let view = {
    db: '',
    collection: ''
}

class SyDB_Config extends SyAPP.Func() {
    constructor() {
        super(
            'sydb',
            async (props) => {
                let uid = props.session.UniqueID
                let extra_message = ''

                // --- Database reset ---
                if (props.resetdb) {
                    await executor.removeForce('/var/lib/sydb')
                    extra_message = ` | ${this.TextColor.green('✅ SyDB reseted !')}`
                }

                // --- New database creation ---
                if (props.inputValue) {
                    if (props.new_db_name) {
                        await SyDB.createDatabase(props.inputValue)
                            .then(async e => {
                                if (e.success) {
                                    extra_message = ` | ${this.TextColor.green(`Database ${this.TextColor.yellow(props.inputValue)} ${this.TextColor.green('created successfully!')}`)}`
                                } else {
                                    extra_message = ` | ${this.TextColor.red(`Database creation error`)}`
                                }
                            })
                            .catch(e => {
                                extra_message = ` | ${this.TextColor.red(`Database intern creation error`)}`
                            })
                    }
                }

                if (props.new_db) {
                    this.WaitInput(uid, { props: { new_db_name: true }, question: 'Database Name : ' })
                }

                // --- View mode toggle (legacy / new dropdown) ---
                if (!this.Storages.Has(uid, 'collection_view_mode')) {
                    this.Storages.Set(uid, 'collection_view_mode', 'new')
                }
                if (props.toggle_view_mode) {
                    const currentMode = this.Storages.Get(uid, 'collection_view_mode')
                    const newMode = currentMode === 'new' ? 'legacy' : 'new'
                    this.Storages.Set(uid, 'collection_view_mode', newMode)
                }

                // =========================
                // PAGE: '' (databases list)
                // =========================
                await this.Page(uid, '', async () => {
                    let databases = await SyDB.listDatabases()
                    if (databases.success) {
                        this.Text(uid, `Databases(${databases.databases.length})${extra_message}`)

                        for (const dbName of databases.databases) {
                            // Fetch collections for this database only once
                            let collections = await SyDB.listCollections(dbName).catch(e => {})

                            await this.DropDown(uid, `drop-${dbName}`, async () => {

                                // --- Collections dropdown (with instance counts) ---
                                await this.DropDown(uid, `drop-l2-1-${dbName}`, async () => {
                                    if (collections.success) {
                                        // For each collection, fetch instance count and display
                                        for (const collectionName of collections.collections) {
                                            let count = 0;
                                            try {
                                                const instances = await SyDB.listInstances(dbName, collectionName);
                                                count = instances.instances ? instances.instances.length : 0;
                                            } catch (err) {
                                                // if listing fails, keep count = 0
                                            }
                                            const viewMode = this.Storages.Get(uid, 'collection_view_mode') || 'new'
                                            const targetPage = viewMode === 'new' ? 'newcollection' : 'collection'
                                            this.Button(uid, {
                                                name: `${collectionName} (${count})`,
                                                props: { page: targetPage, db: dbName, collection: collectionName }
                                            })
                                        }
                                    }
                                }, {
                                    up_buttontext: `Collections(${(collections.success) ? collections.collections.length : '0'})`,
                                    down_buttontext: `🔍 Collections(${(collections.success) ? collections.collections.length : '0'})`,
                                    horizontal: true,
                                    jumpTo: 0,
                                    up_emoji: '🔍'
                                })

                                this.Button(uid, { name: '🗃️  Create Collection' })
                                this.Button(uid, { name: '⚙️  Database Settings' })

                            }, {
                                up_buttontext: dbName,
                                down_buttontext: dbName
                            })
                        }
                    }

                    if (databases.databases.length > 0) {
                        this.Button(uid, { name: ' ' })
                    }

                    this.Button(uid, { name: this.TextColor.orange('＋ New Database'), props: { new_db: true } })
                    this.Button(uid, { name: ' ' })

                    this.Buttons(uid, [
                        { name: '← Return', path: 'config' },
                        { name: this.TextColor.cyan('⚙️  Settings'), props: { page: 'settings' } }
                    ])
                })

                // =============================
                // PAGE: 'collection' (legacy)
                // =============================
                await this.Page(uid, 'collection', async () => {
                    if (props.db) {
                        view.db = props.db
                        view.collection = props.collection
                    }

                    if (props.deleteinstance) {
                        await SyDB.deleteInstance(view.db, view.collection, props.deleteinstance)
                    }

                    let result = await SyDB.listInstances(view.db, view.collection)

                    this.Text(uid, `${view.db} | ${view.collection} | ${this.TextColor.orange(result.instances.length)}`)
                    this.Button(uid, { name: ' ' })

                    let buttontext = []

                    if (result.instances.length) {
                        Object.keys(result.instances[0]).forEach(e => {
                            buttontext.push({ type: 'text', value: `${this.TextColor.yellow(e)} : ` })
                            buttontext.push({ type: 'key', value: e })
                            buttontext.push({ type: 'text', value: ` | ` })
                        })
                        this.Pagination.Button(uid, 'collection', result.instances, {
                            button: {
                                text: buttontext,
                                props: [{ props_key: 'deleteinstance', type: 'key', value: '_id' }]
                            }
                        })
                        this.Button(uid, { name: ' ' })
                        this.Button(uid, '+ New')
                        this.Button(uid, { name: ' ' })
                        this.Button(uid, { name: ' ' })
                    } else {
                        this.Button(uid, '+ New')
                        this.Button(uid, { name: ' ' })
                        this.Button(uid, { name: ' ' })
                    }

                    this.Button(uid, { name: ' ' })
                    this.Button(uid, { name: '← Return', props: { page: '' } })
                })

                // ==================================
                // PAGE: 'newcollection' (dropdown)
                // ==================================
                await this.Page(uid, 'newcollection', async () => {
                    if (props.db) {
                        view.db = props.db
                        view.collection = props.collection
                    }

                    if (props.deleteinstance) {
                        await SyDB.deleteInstance(view.db, view.collection, props.deleteinstance)
                    }

                    let result = await SyDB.listInstances(view.db, view.collection)

                    this.Text(uid, `📁 ${this.TextColor.cyan(view.db)} / ${this.TextColor.cyan(view.collection)}`)
                    this.Text(uid, `📊 ${this.TextColor.orange(result.instances.length)} instances`)
                    this.Button(uid, { name: ' ' })

                    if (result.instances.length) {
                        const allKeys = Object.keys(result.instances[0])

                        await this.Pagination.Button(uid, 'collection', result.instances, {
                            items_per_page: 5,
                            renderItem: async (itemData) => {
                                const firstKey = allKeys[0]
                                const previewValue = itemData.get(firstKey)
                                const preview = typeof previewValue === 'string' && previewValue.length > 45
                                    ? previewValue.substring(0, 45) + '...'
                                    : previewValue

                                const dropdownName = `pagination-collection-${itemData.get('_id')}`

                                await this.DropDown(uid, dropdownName, async () => {
                                    this.Text(uid, `📦 Instance Details`)
                                    this.Text(uid, '─'.repeat(35))

                                    allKeys.forEach(key => {
                                        this.Text(uid, `${this.TextColor.yellow(key)}: ${itemData.get(key)}`)
                                    })

                                    this.Button(uid, { name: ' ' })

                                    this.Buttons(uid, [
                                        {
                                            name: '🗑️  Delete',
                                            path: this.Name,
                                            props: {
                                                deleteinstance: itemData.get('_id'),
                                                page: 'newcollection'
                                            }
                                        },
                                        {
                                            name: '✏️  Edit',
                                            path: this.Name,
                                            props: {
                                                editinstance: itemData.get('_id'),
                                                page: 'edit'
                                            }
                                        }
                                    ])
                                }, {
                                    up_buttontext: preview,
                                    down_buttontext: preview
                                })
                            }
                        })
                    } else {
                        this.Text(uid, '  📭 No instances found')
                        this.Button(uid, { name: ' ' })
                    }

                    this.Button(uid, { name: ' ' })
                    this.Button(uid, { name: '─'.repeat(40) })

                    this.Buttons(uid, [
                        { name: '＋  New Instance', path: this.Name, props: { page: 'new' } },
                        { name: '←  Back', path: this.Name, props: { page: '' } }
                    ])
                })

                // =====================
                // PAGE: 'settings'
                // =====================
                await this.Page(uid, 'settings', async () => {
                    const currentMode = this.Storages.Get(uid, 'collection_view_mode') || 'new'
                    const toggleText = currentMode === 'new'
                        ? `${this.TextColor.green('Active: New View (dropdown)')} | Click to switch to Legacy View`
                        : `${this.TextColor.yellow('Active: Legacy View')} | Click to switch to New View (dropdown)`

                    this.Text(uid, `SyDB Settings${extra_message}`)
                    this.Button(uid, { name: toggleText, props: { toggle_view_mode: true, page: 'settings' } })
                    await this.Emb(uid, {
  name: "emb1",
  filePath: "./SyDB_CorruptTest.js",
  pathMode: 'relative',
  dropdown: {"up_buttontext":"Corruption Test","down_buttontext":"Corruption Test"},
})
                    this.Button(uid, { name: this.TextColor.red('Reset DB'), props: { resetdb: true } })
                    this.Button(uid, { name: ' ' })
                    this.Button(uid, { name: '← Return', props: { page: '' } })
                })
            },
            { linked: [] }
        )
    }
}

export default SyDB_Config