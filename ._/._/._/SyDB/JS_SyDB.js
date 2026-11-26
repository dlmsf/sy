// JS_SyDB.js - Pure Node.js implementation of SYDB database system
// 100% binary compatible with the C version - files can be shared between implementations
// Zero dependencies, using only native Node.js modules

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import http from 'http';
import { fileURLToPath } from 'url';

class JS_SyDB {
    // ==================== CONSTANTS AND CONFIGURATION ====================
    // MUST MATCH C VERSION EXACTLY
    static MAXIMUM_NAME_LENGTH = 256;
    static MAXIMUM_FIELD_LENGTH = 64;
    static MAXIMUM_FIELDS = 128;
    static MAXIMUM_PATH_LENGTH = 1024;
    static MAXIMUM_LINE_LENGTH = 4096;
    static UNIVERSALLY_UNIQUE_IDENTIFIER_SIZE = 37;
    static SYDB_BASE_DIRECTORY = "/var/lib/sydb";
    static LOCK_TIMEOUT_SECONDS = 30;
    static DATA_FILE_EXTENSION = ".sydb";
    static INDEX_FILE_EXTENSION = ".sydidx";
    static FILE_MAGIC_NUMBER = 0x53594442;
    static FILE_VERSION_NUMBER = 2;
    static CACHE_CAPACITY = 10000;
    static B_TREE_ORDER = 16;
    static MAXIMUM_CONCURRENT_READERS = 100;
    static MAXIMUM_THREAD_POOL_SIZE = 16;
    static BATCH_BUFFER_SIZE = 1024 * 1024;
    static MAXIMUM_INDEXES_PER_COLLECTION = 32;
    static QUERY_RESULT_BUFFER_SIZE = 1000;
    static HTTP_SERVER_MAX_CONNECTIONS = 1000;
    static HTTP_SERVER_PORT = 8080;
    static HTTP_SERVER_BUFFER_SIZE = 8192;
    static HTTP_SERVER_MAX_HEADERS = 100;
    static HTTP_SERVER_MAX_CONTENT_LENGTH = 10 * 1024 * 1024;
    static THREAD_POOL_WORKER_COUNT = 16;
    static THREAD_POOL_QUEUE_CAPACITY = 1000;
    static FILE_CONNECTION_POOL_SIZE = 50;
    static RATE_LIMIT_MAX_REQUESTS = 1000000
    static RATE_LIMIT_WINDOW_SECONDS = 60;

    // Real-time metrics and terminal monitor
    static METRICS_API_PATH = '/api/metrics';
    static METRICS_HISTORY_SECONDS = 900;
    static METRICS_LATENCY_SAMPLE_SIZE = 1000;
    static METRICS_STORAGE_CACHE_MILLISECONDS = 5000;
    static METRICS_MAXIMUM_RECENT_ERRORS = 10;
    static METRICS_MAXIMUM_ACTIVE_LISTED = 20;
    static METRICS_MAXIMUM_TRACKED_COLLECTIONS = 200;
    static MONITOR_DEFAULT_HOST = 'localhost';
    static MONITOR_DEFAULT_INTERVAL_MILLISECONDS = 1000;
    static MONITOR_MINIMUM_INTERVAL_MILLISECONDS = 250;
    static MONITOR_MAXIMUM_INTERVAL_MILLISECONDS = 60000;
    static MONITOR_MAXIMUM_BACKOFF_MILLISECONDS = 5000;
    static MONITOR_REQUEST_TIMEOUT_MILLISECONDS = 5000;

    // Correct file header size (from C struct with alignment)
    static FILE_HEADER_SIZE = 136;
    // Correct record header size (from C struct with alignment)
    static RECORD_HEADER_SIZE = 88;

    // Field type enumeration - MUST MATCH C VERSION EXACTLY
    static FIELD_TYPE = {
        STRING: 0,
        INTEGER: 1,
        FLOAT: 2,
        BOOLEAN: 3,
        ARRAY: 4,
        OBJECT: 5,
        NULL: 6
    };

    // HTTP routes documentation - MUST MATCH C VERSION EXACTLY
    static HTTP_ROUTES = [
        {
            method: "GET",
            path: "/api/databases",
            description: "List all databases in the system",
            requestSchema: "No request body required",
            responseSchema: '{\n  "success": true,\n  "databases": ["db1", "db2", ...]\n}'
        },
        {
            method: "POST",
            path: "/api/databases",
            description: "Create a new database",
            requestSchema: '{\n  "name": "database_name"\n}',
            responseSchema: '{\n  "success": true,\n  "message": "Database created successfully"\n}'
        },
        {
            method: "DELETE",
            path: "/api/databases/{database_name}",
            description: "Delete a database",
            requestSchema: "No request body required",
            responseSchema: '{\n  "success": true,\n  "message": "Database deleted successfully"\n}'
        },
        {
            method: "GET",
            path: "/api/databases/{database_name}/collections",
            description: "List all collections in a specific database",
            requestSchema: "No request body required",
            responseSchema: '{\n  "success": true,\n  "collections": ["collection1", "collection2", ...]\n}'
        },
        {
            method: "POST",
            path: "/api/databases/{database_name}/collections",
            description: "Create a new collection with schema",
            requestSchema: '{\n  "name": "collection_name",\n  "schema": [\n    {\n      "name": "field_name",\n      "type": "string|int|float|bool|array|object",\n      "required": true|false,\n      "indexed": true|false\n    }\n  ]\n}',
            responseSchema: '{\n  "success": true,\n  "message": "Collection created successfully"\n}'
        },
        {
            method: "DELETE",
            path: "/api/databases/{database_name}/collections/{collection_name}",
            description: "Delete a collection",
            requestSchema: "No request body required",
            responseSchema: '{\n  "success": true,\n  "message": "Collection deleted successfully"\n}'
        },
        {
            method: "GET",
            path: "/api/databases/{database_name}/collections/{collection_name}/instances",
            description: "List all instances in a collection with optional query",
            requestSchema: "Optional query parameters: ?query=field1:value1,field2:value2",
            responseSchema: '{\n  "success": true,\n  "instances": [\n    {\n      "_id": "uuid",\n      "_created_at": timestamp,\n      "field1": "value1",\n      ...\n    }\n  ]\n}'
        },
        {
            method: "POST",
            path: "/api/databases/{database_name}/collections/{collection_name}/instances",
            description: "Insert a new instance into a collection",
            requestSchema: '{\n  "field1": "value1",\n  "field2": "value2",\n  ...\n}',
            responseSchema: '{\n  "success": true,\n  "id": "generated_uuid",\n  "message": "Instance created successfully"\n}'
        },
        {
            method: "PUT",
            path: "/api/databases/{database_name}/collections/{collection_name}/instances/{instance_id}",
            description: "Update an existing instance",
            requestSchema: '{\n  "field1": "new_value1",\n  "field2": "new_value2",\n  ...\n}',
            responseSchema: '{\n  "success": true,\n  "message": "Instance updated successfully"\n}'
        },
        {
            method: "DELETE",
            path: "/api/databases/{database_name}/collections/{collection_name}/instances/{instance_id}",
            description: "Delete an instance",
            requestSchema: "No request body required",
            responseSchema: '{\n  "success": true,\n  "message": "Instance deleted successfully"\n}'
        },
        {
            method: "GET",
            path: "/api/databases/{database_name}/collections/{collection_name}/schema",
            description: "Get the schema of a collection",
            requestSchema: "No request body required",
            responseSchema: '{\n  "success": true,\n  "schema": {\n    "fields": [\n      {\n        "name": "field_name",\n        "type": "string|int|float|bool|array|object",\n        "required": true|false,\n        "indexed": true|false\n      }\n    ]\n  }\n}'
        },
        {
            method: "POST",
            path: "/api/execute",
            description: "Execute SYDB commands via HTTP",
            requestSchema: '{\n  "command": "sydb command string",\n  "arguments": ["arg1", "arg2", ...]\n}',
            responseSchema: '{\n  "success": true|false,\n  "result": "command output or data",\n  "error": "error message if any"\n}'
        },
        {
            method: "GET",
            path: "/api/metrics",
            description: "Real-time server metrics (sections: /instance, /requests, /performance, /operations, /storage)",
            requestSchema: "No request body required",
            responseSchema: '{\n  "success": true,\n  "metrics": {\n    "instance": {},\n    "resources": {},\n    "requests": {},\n    "performance": {},\n    "operations": {},\n    "recent_errors": [],\n    "storage": {}\n  }\n}'
        }
    ];

    constructor() {
        this.verboseMode = false;
        this.serverInstance = null;
        this.threadPool = null;
        this.fileConnectionPool = null;
        this.rateLimiter = null;
        this.cache = null;
        this.fileLocks = new Map();
        this.httpServer = null;
        this.runningFlag = false;
        this.workerThreads = [];
        this.serverMetrics = null;

        // Initialize base directory
        this.initializeBaseDirectory();
    }

    // ==================== HIGH-PERFORMANCE UTILITY FUNCTIONS ====================
    // MUST MATCH C VERSION IMPLEMENTATION EXACTLY

    buildJsonArrayHighPerformance(items) {
        if (!items || items.length === 0) {
            return "[]";
        }

        let itemsAreJson = false;
        if (items.length > 0 && items[0] && items[0].length > 0) {
            if (items[0][0] === '{') {
                itemsAreJson = true;
            }
        }

        let resultString = "[";
        for (let i = 0; i < items.length; i++) {
            if (items[i]) {
                if (i > 0) resultString += ",";
                if (!itemsAreJson) resultString += '"';
                resultString += items[i];
                if (!itemsAreJson) resultString += '"';
            }
        }
        resultString += "]";
        return resultString;
    }

    buildJsonObjectHighPerformance(keys, values) {
        if (!keys || !values || keys.length === 0 || values.length === 0) {
            return "{}";
        }
        let resultString = "{";
        for (let i = 0; i < Math.min(keys.length, values.length); i++) {
            if (keys[i] && values[i]) {
                if (i > 0) resultString += ",";
                resultString += '"' + keys[i] + '":"' + values[i] + '"';
            }
        }
        resultString += "}";
        return resultString;
    }

    // ==================== THREAD POOL IMPLEMENTATION ====================

    createThreadPool(workerCount, queueCapacity) {
        const threadPool = {
            workerThreads: [],
            workerThreadCount: workerCount,
            taskQueue: new Array(queueCapacity),
            queueCapacity: queueCapacity,
            queueSize: 0,
            queueHead: 0,
            queueTail: 0,
            queueMutex: false,
            shutdownFlag: false
        };

        for (let i = 0; i < workerCount; i++) {
            this.createWorkerThread(threadPool);
        }

        this.threadPool = threadPool;
        return threadPool;
    }

    createWorkerThread(threadPool) {
        const worker = async () => {
            while (true) {
                while (threadPool.queueMutex) {
                    await new Promise(resolve => setTimeout(resolve, 1));
                }
                threadPool.queueMutex = true;

                while (threadPool.queueSize === 0 && !threadPool.shutdownFlag) {
                    threadPool.queueMutex = false;
                    await new Promise(resolve => setTimeout(resolve, 100));
                    while (threadPool.queueMutex) {
                        await new Promise(resolve => setTimeout(resolve, 1));
                    }
                    threadPool.queueMutex = true;
                }

                if (threadPool.shutdownFlag && threadPool.queueSize === 0) {
                    threadPool.queueMutex = false;
                    break;
                }

                if (threadPool.queueSize === 0) {
                    threadPool.queueMutex = false;
                    continue;
                }

                const task = threadPool.taskQueue[threadPool.queueHead];
                threadPool.queueHead = (threadPool.queueHead + 1) % threadPool.queueCapacity;
                threadPool.queueSize--;

                threadPool.queueMutex = false;

                if (task) {
                    try {
                        await task.handler(task.context);
                    } catch (error) {
                        console.error('Task processing error:', error);
                    }
                    this.cleanupClientConnection(task.context);
                }
            }
        };

        threadPool.workerThreads.push(worker);
        worker();
        return worker;
    }

    destroyThreadPool(threadPool) {
        if (!threadPool) return;

        threadPool.shutdownFlag = true;

        for (let i = 0; i < threadPool.queueSize; i++) {
            const context = threadPool.taskQueue[
                (threadPool.queueHead + i) % threadPool.queueCapacity
            ];
            if (context) {
                this.cleanupClientConnection(context);
            }
        }

        threadPool.workerThreads = [];
        threadPool.taskQueue = [];
        this.threadPool = null;
    }

    async threadPoolSubmitTask(threadPool, clientContext) {
        if (!threadPool || !clientContext || threadPool.shutdownFlag) {
            return -1;
        }

        while (threadPool.queueMutex) {
            await new Promise(resolve => setTimeout(resolve, 1));
        }
        threadPool.queueMutex = true;

        while (threadPool.queueSize === threadPool.queueCapacity && !threadPool.shutdownFlag) {
            threadPool.queueMutex = false;
            await new Promise(resolve => setTimeout(resolve, 100));
            if (threadPool.shutdownFlag) return -1;
            while (threadPool.queueMutex) {
                await new Promise(resolve => setTimeout(resolve, 1));
            }
            threadPool.queueMutex = true;
        }

        if (threadPool.shutdownFlag) {
            threadPool.queueMutex = false;
            return -1;
        }

        threadPool.taskQueue[threadPool.queueTail] = {
            context: clientContext,
            handler: this.httpClientHandler.bind(this)
        };
        threadPool.queueTail = (threadPool.queueTail + 1) % threadPool.queueCapacity;
        threadPool.queueSize++;

        threadPool.queueMutex = false;
        return 0;
    }

    // ==================== FILE CONNECTION POOL ====================

    createFileConnectionPool(poolSize) {
        const connectionPool = {
            fileConnections: new Array(poolSize),
            connectionPoolSize: poolSize,
            poolMutex: false
        };

        for (let i = 0; i < poolSize; i++) {
            connectionPool.fileConnections[i] = {
                databaseName: '',
                collectionName: '',
                dataFile: null,
                lastUsedTimestamp: 0,
                inUseFlag: false
            };
        }

        this.fileConnectionPool = connectionPool;
        return connectionPool;
    }

    destroyFileConnectionPool(connectionPool) {
        if (!connectionPool) return;

        for (let i = 0; i < connectionPool.connectionPoolSize; i++) {
            const connection = connectionPool.fileConnections[i];
            if (connection.dataFile && connection.dataFile.fd) {
                try {
                    fs.closeSync(connection.dataFile.fd);
                } catch (error) {
                    // Ignore close errors
                }
            }
        }

        connectionPool.fileConnections = [];
        this.fileConnectionPool = null;
    }

    async getFileConnection(connectionPool, databaseName, collectionName) {
        if (!connectionPool || !databaseName || !collectionName) {
            return null;
        }

        while (connectionPool.poolMutex) {
            await new Promise(resolve => setTimeout(resolve, 1));
        }
        connectionPool.poolMutex = true;

        try {
            for (let i = 0; i < connectionPool.connectionPoolSize; i++) {
                const connection = connectionPool.fileConnections[i];

                if (!connection.inUseFlag &&
                    connection.databaseName === databaseName &&
                    connection.collectionName === collectionName) {

                    connection.inUseFlag = true;
                    connection.lastUsedTimestamp = Date.now();
                    return connection.dataFile;
                }
            }

            for (let i = 0; i < connectionPool.connectionPoolSize; i++) {
                const connection = connectionPool.fileConnections[i];

                if (!connection.inUseFlag) {
                    const dataFile = await this.openSecureDataFileWithOptimizations(
                        databaseName, collectionName, 'r+'
                    );

                    if (dataFile) {
                        connection.databaseName = databaseName;
                        connection.collectionName = collectionName;
                        connection.dataFile = dataFile;
                        connection.lastUsedTimestamp = Date.now();
                        connection.inUseFlag = true;
                        return dataFile;
                    }
                }
            }

            return await this.openSecureDataFileWithOptimizations(databaseName, collectionName, 'r+');
        } finally {
            connectionPool.poolMutex = false;
        }
    }

    releaseFileConnection(connectionPool, dataFile) {
        if (!connectionPool || !dataFile) return;

        while (connectionPool.poolMutex) {
            setTimeout(() => {}, 1);
            return;
        }
        connectionPool.poolMutex = true;

        try {
            for (let i = 0; i < connectionPool.connectionPoolSize; i++) {
                const connection = connectionPool.fileConnections[i];

                if (connection.dataFile === dataFile && connection.inUseFlag) {
                    connection.inUseFlag = false;
                    connection.lastUsedTimestamp = Date.now();
                    return;
                }
            }

            if (dataFile && dataFile.fd) {
                try {
                    fs.closeSync(dataFile.fd);
                } catch (error) {
                    // Ignore close errors
                }
            }
        } finally {
            connectionPool.poolMutex = false;
        }
    }

    // ==================== RATE LIMITING ====================

    createRateLimiter() {
        const rateLimiter = {
            rateLimitEntries: new Map(),
            rateLimitMutex: false
        };

        this.rateLimiter = rateLimiter;
        return rateLimiter;
    }

    destroyRateLimiter(rateLimiter) {
        if (!rateLimiter) return;
        rateLimiter.rateLimitEntries.clear();
        this.rateLimiter = null;
    }

    async checkRateLimit(rateLimiter, clientIpAddress) {
        if (!rateLimiter || !clientIpAddress) {
            return true;
        }
    
        if (clientIpAddress === "127.0.0.1" ||
            clientIpAddress === "::1" ||
            clientIpAddress === "localhost") {
            return true;
        }
    
        while (rateLimiter.rateLimitMutex) {
            await new Promise(resolve => setTimeout(resolve, 1));
        }
        rateLimiter.rateLimitMutex = true;
    
        try {
            const currentTime = Math.floor(Date.now() / 1000);
            let requestAllowed = true;
    
            let clientEntry = rateLimiter.rateLimitEntries.get(clientIpAddress);
    
            if (!clientEntry) {
                clientEntry = {
                    clientIpAddress: clientIpAddress,
                    lastRequestTime: currentTime,
                    requestCount: 1,
                    rateLimitWindowStart: currentTime
                };
                rateLimiter.rateLimitEntries.set(clientIpAddress, clientEntry);
                requestAllowed = true;
            } else {
                // Use the class constant properly
                const maxRequests = JS_SyDB.RATE_LIMIT_MAX_REQUESTS;
                
                if (currentTime - clientEntry.rateLimitWindowStart >= JS_SyDB.RATE_LIMIT_WINDOW_SECONDS) {
                    // Reset the counter for new window
                    clientEntry.requestCount = 1;
                    clientEntry.rateLimitWindowStart = currentTime;
                    requestAllowed = true;
                } else {
                    if (clientEntry.requestCount >= maxRequests) {
                        requestAllowed = false;
                    } else {
                        clientEntry.requestCount++;
                        requestAllowed = true;
                    }
                }
                clientEntry.lastRequestTime = currentTime;
            }
    
            return requestAllowed;
        } finally {
            rateLimiter.rateLimitMutex = false;
        }
    }

    // ==================== OPTIMIZED PATH PARSING ====================
    // MUST MATCH C VERSION EXACTLY

    parseApiPathOptimized(path) {
        if (!path) {
            return null;
        }

        const components = {
            databaseName: '',
            collectionName: '',
            instanceId: ''
        };

        let currentPosition = path;

        if (!currentPosition.startsWith('/api/databases/')) {
            return null;
        }
        currentPosition = currentPosition.substring(15);

        const databaseNameEnd = currentPosition.indexOf('/');
        if (databaseNameEnd === -1) {
            if (currentPosition.length >= JS_SyDB.MAXIMUM_NAME_LENGTH || currentPosition.length === 0) {
                return null;
            }
            components.databaseName = currentPosition;
            return components;
        }

        const databaseNameLength = databaseNameEnd;
        if (databaseNameLength >= JS_SyDB.MAXIMUM_NAME_LENGTH || databaseNameLength === 0) {
            return null;
        }
        components.databaseName = currentPosition.substring(0, databaseNameLength);

        currentPosition = currentPosition.substring(databaseNameEnd + 1);

        if (currentPosition.length === 0) {
            return components;
        }

        if (currentPosition.startsWith('collections/')) {
            currentPosition = currentPosition.substring(12);

            const collectionNameEnd = currentPosition.indexOf('/');
            if (collectionNameEnd === -1) {
                if (currentPosition.length >= JS_SyDB.MAXIMUM_NAME_LENGTH || currentPosition.length === 0) {
                    return null;
                }
                components.collectionName = currentPosition;
                return components;
            }

            const collectionNameLength = collectionNameEnd;
            if (collectionNameLength >= JS_SyDB.MAXIMUM_NAME_LENGTH || collectionNameLength === 0) {
                return null;
            }
            components.collectionName = currentPosition.substring(0, collectionNameLength);

            currentPosition = currentPosition.substring(collectionNameEnd + 1);

            if (currentPosition.startsWith('instances/')) {
                currentPosition = currentPosition.substring(10);

                if (currentPosition.length >= JS_SyDB.UNIVERSALLY_UNIQUE_IDENTIFIER_SIZE || currentPosition.length === 0) {
                    return null;
                }
                components.instanceId = currentPosition;
            } else if (currentPosition === 'schema') {
                return components;
            } else if (currentPosition === 'instances') {
                return components;
            }
        }

        return components;
    }

    // ==================== HELPER FUNCTIONS ====================
    // MUST MATCH C VERSION EXACTLY

    stringRepeat(character, count) {
        if (count > 127) count = 127;
        return character.repeat(count);
    }

    displayHttpRoutes() {
        console.log("SYDB HTTP Server Available Routes:");
        console.log("===================================\n");

        for (const route of JS_SyDB.HTTP_ROUTES) {
            console.log(`Method: ${route.method}`);
            console.log(`Path: ${route.path}`);
            console.log(`Description: ${route.description}`);
            console.log(`Request Schema:\n${route.requestSchema}`);
            console.log(`Response Schema:\n${route.responseSchema}`);
            console.log(this.stringRepeat('-', 60));
        }

        console.log("\nUsage Examples:");
        console.log("1. List all databases:");
        console.log("   curl -X GET http://localhost:8080/api/databases\n");

        console.log("2. Create a new database:");
        console.log("   curl -X POST http://localhost:8080/api/databases \\");
        console.log("     -H \"Content-Type: application/json\" \\");
        console.log("     -d '{\"name\": \"mydatabase\"}'\n");

        console.log("3. Create a new instance:");
        console.log("   curl -X POST http://localhost:8080/api/databases/mydb/collections/users/instances \\");
        console.log("     -H \"Content-Type: application/json\" \\");
        console.log("     -d '{\"name\": \"John\", \"age\": 30}'\n");

        console.log("4. Find instances with query:");
        console.log("   curl -X GET \"http://localhost:8080/api/databases/mydb/collections/users/instances?query=name:John\"");
    }

    createSuccessResponse(message) {
        return `{"success":true,"message":"${message}"}`;
    }

    createSuccessResponseWithData(dataType, dataJson) {
        return `{"success":true,"${dataType}":${dataJson}}`;
    }

    createErrorResponse(errorMessage) {
        return `{"success":false,"error":"${errorMessage}"}`;
    }

    extractPathParameter(path, prefix) {
        if (!path || !prefix) return null;

        let paramStart = path.substring(prefix.length);
        if (paramStart.startsWith('/')) {
            paramStart = paramStart.substring(1);
        }

        const paramEnd = paramStart.indexOf('/');
        if (paramEnd === -1) {
            return paramStart;
        }

        return paramStart.substring(0, paramEnd);
    }

    urlDecode(encodedString) {
        if (!encodedString) return '';
        return decodeURIComponent(encodedString.replace(/\+/g, ' '));
    }

    // ==================== SECURITY VALIDATION FUNCTIONS ====================
    // MUST MATCH C VERSION EXACTLY

    validatePathComponent(component) {
        if (!component || component.length === 0) return false;
        if (component.length >= JS_SyDB.MAXIMUM_NAME_LENGTH) return false;

        if (component.includes('/')) return false;
        if (component.includes('\\')) return false;
        if (component === '.') return false;
        if (component === '..') return false;

        for (let i = 0; i < component.length; i++) {
            const currentCharacter = component[i];

            if (currentCharacter < ' ' || currentCharacter === '\x7F') return false;
            if (currentCharacter === ' ') return false;

            const problematicChars = '$&*?!@#%^()[]{}|;:\'"<>`~';
            if (problematicChars.includes(currentCharacter)) return false;

            const allowedChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-_.';
            if (!allowedChars.includes(currentCharacter)) {
                return false;
            }
        }

        return true;
    }

    validateDatabaseName(databaseName) {
        return this.validatePathComponent(databaseName);
    }

    validateCollectionName(collectionName) {
        return this.validatePathComponent(collectionName);
    }

    validateFieldName(fieldName) {
        if (!fieldName || fieldName.length === 0) return false;
        if (fieldName.length >= JS_SyDB.MAXIMUM_FIELD_LENGTH) return false;

        for (let i = 0; i < fieldName.length; i++) {
            const currentCharacter = fieldName[i];
            if (!((currentCharacter >= 'a' && currentCharacter <= 'z') ||
                  (currentCharacter >= 'A' && currentCharacter <= 'Z') ||
                  (currentCharacter >= '0' && currentCharacter <= '9') ||
                  currentCharacter === '_')) {
                return false;
            }
        }

        return true;
    }

    // ==================== SECURE UTILITY FUNCTIONS ====================
    // MUST MATCH C VERSION EXACTLY

    generateSecureUniversallyUniqueIdentifier() {
        const hexChars = '0123456789abcdef';
        const segments = [8, 4, 4, 4, 12];
        let uuid = '';

        for (let i = 0; i < segments.length; i++) {
            if (i > 0) uuid += '-';
            for (let j = 0; j < segments[i]; j++) {
                const randomByte = crypto.randomBytes(1)[0];
                uuid += hexChars[randomByte % 16];
            }
        }

        return uuid;
    }

    async createSecureDirectoryRecursively(dirPath) {
        try {
            await fs.promises.mkdir(dirPath, { recursive: true, mode: 0o755 });
            return 0;
        } catch (error) {
            if (error.code !== 'EEXIST') {
                if (this.verboseMode) {
                    console.error(`Error creating directory ${dirPath}: ${error.message}`);
                }
                return -1;
            }
            return 0;
        }
    }

    computeCrc32Checksum(data) {
        let crc = 0xFFFFFFFF;
        const table = [];

        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let j = 0; j < 8; j++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[i] = c;
        }

        if (typeof data === 'string') {
            data = Buffer.from(data);
        }

        for (let i = 0; i < data.length; i++) {
            crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
        }

        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    getSecureSydbBaseDirectoryPath() {
        const environmentDirectory = process.env.SYDB_BASE_DIR;

        if (environmentDirectory && environmentDirectory.length < JS_SyDB.MAXIMUM_PATH_LENGTH) {
            return environmentDirectory;
        } else {
            return JS_SyDB.SYDB_BASE_DIRECTORY;
        }
    }

    async acquireSecureExclusiveLock(lockFilePath) {
        // In this JS implementation, we don't have flock. We'll just return a dummy handle.
        const lock = {
            fileDescriptor: 1,
            lockFilePath: lockFilePath
        };
        return lock;
    }

    releaseSecureExclusiveLock(lockHandle) {
        // Nothing to do
    }

    // ==================== CACHE IMPLEMENTATION ====================

    createSecureLruCache(capacity) {
        const cache = {
            entries: new Map(),
            capacity: capacity,
            size: 0,
            cacheHits: 0,
            cacheMisses: 0,
            lock: false
        };
        this.cache = cache;
        return cache;
    }

    destroySecureLruCache(cache) {
        if (!cache) return;
        cache.entries.clear();
        this.cache = null;
    }

    lruCachePutSecure(cache, uuid, instance) {
        if (!cache || !uuid || !instance) return;

        while (cache.lock) {
            setTimeout(() => {}, 1);
            return;
        }
        cache.lock = true;

        try {
            const existing = cache.entries.get(uuid);
            cache.entries.set(uuid, {
                instance: instance,
                lastAccessedTime: Date.now(),
                accessCount: (existing ? existing.accessCount : 0) + 1
            });
            cache.size++;

            if (cache.size > cache.capacity) {
                let oldestKey = null;
                let oldestTime = Date.now();

                for (const [key, value] of cache.entries) {
                    if (value.lastAccessedTime < oldestTime) {
                        oldestTime = value.lastAccessedTime;
                        oldestKey = key;
                    }
                }

                if (oldestKey) {
                    cache.entries.delete(oldestKey);
                    cache.size--;
                }
            }
        } finally {
            cache.lock = false;
        }
    }

    lruCacheGetSecure(cache, uuid) {
        if (!cache || !uuid) return null;

        while (cache.lock) {
            setTimeout(() => {}, 1);
            return null;
        }
        cache.lock = true;

        try {
            const entry = cache.entries.get(uuid);
            if (entry) {
                entry.lastAccessedTime = Date.now();
                entry.accessCount++;
                cache.cacheHits++;
                return entry.instance;
            }
            cache.cacheMisses++;
            return null;
        } finally {
            cache.lock = false;
        }
    }

    // ==================== SECURE FILE OPERATIONS ====================
    // MUST MATCH C VERSION BINARY FORMAT EXACTLY

    async openSecureDataFileWithOptimizations(databaseName, collectionName, mode) {
        if (!this.validateDatabaseName(databaseName) || !this.validateCollectionName(collectionName)) {
            return null;
        }

        const basePath = this.getSecureSydbBaseDirectoryPath();
        const filePath = path.join(basePath, databaseName, collectionName, `data${JS_SyDB.DATA_FILE_EXTENSION}`);

        try {
            await this.createSecureDirectoryRecursively(path.dirname(filePath));

            let flags = 'r';
            if (mode === 'r+') flags = 'r+';
            else if (mode === 'w+') flags = 'w+';
            else if (mode === 'r') flags = 'r';
            else flags = 'w';

            const fd = fs.openSync(filePath, flags);
            return {
                fd: fd,
                path: filePath,
                close: () => {
                    try { fs.closeSync(fd); } catch (e) {}
                }
            };
        } catch (error) {
            if (mode.includes('r') && error.code === 'ENOENT') {
                return null;
            }
            try {
                await this.createSecureDirectoryRecursively(path.dirname(filePath));
                const fd = fs.openSync(filePath, 'w+');
                await this.initializeSecureHighPerformanceDataFile({ fd: fd, path: filePath, close: () => {} });
                return {
                    fd: fd,
                    path: filePath,
                    close: () => {
                        try { fs.closeSync(fd); } catch (e) {}
                    }
                };
            } catch (error2) {
                if (this.verboseMode) {
                    console.error(`Error opening file ${filePath}:`, error2);
                }
                return null;
            }
        }
    }

    async initializeSecureHighPerformanceDataFile(dataFile) {
        if (!dataFile) return -1;

        const headerBuffer = Buffer.alloc(JS_SyDB.FILE_HEADER_SIZE);
        // Write all fields in little-endian order
        headerBuffer.writeUInt32LE(JS_SyDB.FILE_MAGIC_NUMBER, 0);
        headerBuffer.writeUInt32LE(JS_SyDB.FILE_VERSION_NUMBER, 4);
        headerBuffer.writeBigUInt64LE(BigInt(0), 8);
        headerBuffer.writeBigUInt64LE(BigInt(JS_SyDB.FILE_HEADER_SIZE), 16);
        headerBuffer.writeBigUInt64LE(BigInt(JS_SyDB.FILE_HEADER_SIZE), 24);
        headerBuffer.writeUInt32LE(0, 32);
        // Padding at 36-39 (4 bytes) is automatically zero
        headerBuffer.writeBigUInt64LE(BigInt(0), 40);
        headerBuffer.writeUInt32LE(0, 48);
        // The rest (reserved) is already zero

        try {
            fs.writeSync(dataFile.fd, headerBuffer, 0, JS_SyDB.FILE_HEADER_SIZE, 0);
            return 0;
        } catch (error) {
            if (this.verboseMode) {
                console.error('Error initializing data file:', error);
            }
            return -1;
        }
    }

    readSecureFileHeaderInformation(dataFile) {
        if (!dataFile) return null;

        try {
            const buffer = Buffer.alloc(JS_SyDB.FILE_HEADER_SIZE);
            const bytesRead = fs.readSync(dataFile.fd, buffer, 0, JS_SyDB.FILE_HEADER_SIZE, 0);
            if (bytesRead !== JS_SyDB.FILE_HEADER_SIZE) {
                return null;
            }

            const magicNumber = buffer.readUInt32LE(0);
            if (magicNumber !== JS_SyDB.FILE_MAGIC_NUMBER) {
                if (this.verboseMode) {
                    console.error('Invalid magic number:', magicNumber);
                }
                return null;
            }

            return {
                magicNumber: magicNumber,
                versionNumber: buffer.readUInt32LE(4),
                recordCount: Number(buffer.readBigUInt64LE(8)),
                fileSize: Number(buffer.readBigUInt64LE(16)),
                freeOffset: Number(buffer.readBigUInt64LE(24)),
                schemaChecksum: buffer.readUInt32LE(32),
                indexRootOffset: Number(buffer.readBigUInt64LE(40)),
                flags: buffer.readUInt32LE(48),
                reserved: buffer.slice(52, 136)
            };
        } catch (error) {
            if (this.verboseMode) {
                console.error('Error reading file header:', error);
            }
            return null;
        }
    }

    writeSecureFileHeaderInformation(dataFile, fileHeader) {
        if (!dataFile || !fileHeader) return -1;

        try {
            const buffer = Buffer.alloc(JS_SyDB.FILE_HEADER_SIZE);
            buffer.writeUInt32LE(fileHeader.magicNumber, 0);
            buffer.writeUInt32LE(fileHeader.versionNumber, 4);
            buffer.writeBigUInt64LE(BigInt(fileHeader.recordCount), 8);
            buffer.writeBigUInt64LE(BigInt(fileHeader.fileSize), 16);
            buffer.writeBigUInt64LE(BigInt(fileHeader.freeOffset), 24);
            buffer.writeUInt32LE(fileHeader.schemaChecksum, 32);
            // Padding 36-39 already zero
            buffer.writeBigUInt64LE(BigInt(fileHeader.indexRootOffset), 40);
            buffer.writeUInt32LE(fileHeader.flags, 48);
            // Reserved remains zero

            fs.writeSync(dataFile.fd, buffer, 0, JS_SyDB.FILE_HEADER_SIZE, 0);
            return 0;
        } catch (error) {
            if (this.verboseMode) {
                console.error('Error writing file header:', error);
            }
            return -1;
        }
    }

    // ==================== SECURE JSON PARSING FUNCTIONS ====================
    // MUST MATCH C VERSION EXACTLY

    jsonGetStringValue(jsonData, key) {
        if (!jsonData || !key || key.length >= 200) return null;

        try {
            const json = JSON.parse(jsonData);
            const value = json[key];
            return value !== undefined ? String(value) : null;
        } catch (error) {
            const searchPattern = `"${key}":"`;
            let valueStart = jsonData.indexOf(searchPattern);
            if (valueStart === -1) {
                const searchPattern2 = `"${key}":`;
                const valueStart2 = jsonData.indexOf(searchPattern2);
                if (valueStart2 === -1) return null;

                const valueStartPos = valueStart2 + searchPattern2.length;
                let valueEnd = jsonData.indexOf(',', valueStartPos);
                if (valueEnd === -1) valueEnd = jsonData.indexOf('}', valueStartPos);
                if (valueEnd === -1) return null;

                let value = jsonData.substring(valueStartPos, valueEnd).trim();

                if (value.startsWith('"') && value.endsWith('"')) {
                    value = value.substring(1, value.length - 1);
                }

                return value;
            }

            const valueStartPos = valueStart + searchPattern.length;
            const valueEnd = jsonData.indexOf('"', valueStartPos);
            if (valueEnd === -1) return null;

            return jsonData.substring(valueStartPos, valueEnd);
        }
    }

    jsonGetIntegerValue(jsonData, key) {
        if (!jsonData || !key) return 0;
        const stringValue = this.jsonGetStringValue(jsonData, key);
        return stringValue ? parseInt(stringValue, 10) : 0;
    }

    jsonHasField(jsonData, key) {
        if (!jsonData || !key) return false;
        return jsonData.includes(`"${key}":`);
    }

    jsonMatchesQueryConditions(jsonData, query) {
        if (!jsonData) return false;

        if (!query || query.length === 0) {
            return true;
        }

        if (query.length >= 1024) return false;

        const queryTokens = query.split(',');
        for (const token of queryTokens) {
            const trimmedToken = token.trim();
            if (!trimmedToken) continue;

            const colonPos = trimmedToken.indexOf(':');
            if (colonPos === -1) return false;

            const fieldName = trimmedToken.substring(0, colonPos).trim();
            let expectedValue = trimmedToken.substring(colonPos + 1).trim();

            if (expectedValue.startsWith('"') && expectedValue.endsWith('"')) {
                expectedValue = expectedValue.substring(1, expectedValue.length - 1);
            }

            if (!this.validateFieldName(fieldName)) {
                return false;
            }

            const actualStringValue = this.jsonGetStringValue(jsonData, fieldName);
            if (actualStringValue) {
                if (actualStringValue !== expectedValue) {
                    return false;
                }
            } else {
                const actualIntegerValue = this.jsonGetIntegerValue(jsonData, fieldName);
                const expectedIntegerValue = parseInt(expectedValue, 10);
                if (actualIntegerValue !== expectedIntegerValue) {
                    return false;
                }
            }
        }

        return true;
    }

    // ==================== SECURE SCHEMA MANAGEMENT ====================
    // MUST MATCH C VERSION EXACTLY

    parseSecureFieldTypeFromString(typeString) {
        if (!typeString) return JS_SyDB.FIELD_TYPE.NULL;
    
        const typeMap = {
            'string': JS_SyDB.FIELD_TYPE.STRING,
            'int': JS_SyDB.FIELD_TYPE.INTEGER,
            'integer': JS_SyDB.FIELD_TYPE.INTEGER,
            'float': JS_SyDB.FIELD_TYPE.FLOAT,
            'bool': JS_SyDB.FIELD_TYPE.BOOLEAN,
            'boolean': JS_SyDB.FIELD_TYPE.BOOLEAN,
            'array': JS_SyDB.FIELD_TYPE.ARRAY,
            'object': JS_SyDB.FIELD_TYPE.OBJECT
        };
    
        const lowerType = typeString.toLowerCase().trim();
        const mappedType = typeMap[lowerType];
        
        if (mappedType === undefined) {
            return JS_SyDB.FIELD_TYPE.NULL;
        }
        
        return mappedType;
    }

    convertSecureFieldTypeToString(fieldType) {
    const reverseMap = {
        [JS_SyDB.FIELD_TYPE.STRING]: 'string',
        [JS_SyDB.FIELD_TYPE.INTEGER]: 'int',
        [JS_SyDB.FIELD_TYPE.FLOAT]: 'float',
        [JS_SyDB.FIELD_TYPE.BOOLEAN]: 'bool',
        [JS_SyDB.FIELD_TYPE.ARRAY]: 'array',
        [JS_SyDB.FIELD_TYPE.OBJECT]: 'object',
        [JS_SyDB.FIELD_TYPE.NULL]: 'null'
    };

    return reverseMap[fieldType] || 'null';
}

    async loadSecureSchemaFromFile(databaseName, collectionName, fields, fieldCount) {
        if (!this.validateDatabaseName(databaseName) || !this.validateCollectionName(collectionName)) {
            return -1;
        }

        const basePath = this.getSecureSydbBaseDirectoryPath();
        const schemaFilePath = path.join(basePath, databaseName, collectionName, 'schema.txt');

        try {
            const schemaContent = await fs.promises.readFile(schemaFilePath, 'utf8');
            const lines = schemaContent.split('\n').filter(line => line.trim());

            fieldCount[0] = 0;
            for (const line of lines) {
                const parts = line.split(':');
                if (parts.length >= 4 && fieldCount[0] < JS_SyDB.MAXIMUM_FIELDS) {
                    const field = {
                        name: parts[0],
                        type: this.parseSecureFieldTypeFromString(parts[1]),
                        required: parts[2] === 'required',
                        indexed: parts[3] === 'indexed'
                    };
                    fields[fieldCount[0]] = field;
                    fieldCount[0]++;
                }
            }
            return 0;
        } catch (error) {
            if (this.verboseMode) {
                console.error(`Error loading schema for collection '${collectionName}':`, error);
            }
            return -1;
        }
    }

    validateSecureFieldValueAgainstSchema(fieldName, value, type) {
        if (!fieldName || !this.validateFieldName(fieldName)) {
            return false;
        }

        if (!value || value.length === 0) {
            return true;
        }

        if (value.length >= JS_SyDB.MAXIMUM_LINE_LENGTH) {
            if (this.verboseMode) {
                console.error(`Validation error: Field '${fieldName}' value too long`);
            }
            return false;
        }

        switch (type) {
            case JS_SyDB.FIELD_TYPE.INTEGER: {
                const num = parseInt(value, 10);
                if (isNaN(num)) {
                    if (this.verboseMode) {
                        console.error(`Validation error: Field '${fieldName}' should be integer but got '${value}'`);
                    }
                    return false;
                }
                return true;
            }
            case JS_SyDB.FIELD_TYPE.FLOAT: {
                const num = parseFloat(value);
                if (isNaN(num)) {
                    if (this.verboseMode) {
                        console.error(`Validation error: Field '${fieldName}' should be float but got '${value}'`);
                    }
                    return false;
                }
                return true;
            }
            case JS_SyDB.FIELD_TYPE.BOOLEAN: {
                if (value !== 'true' && value !== 'false' && value !== '1' && value !== '0') {
                    if (this.verboseMode) {
                        console.error(`Validation error: Field '${fieldName}' should be boolean but got '${value}'`);
                    }
                    return false;
                }
                return true;
            }
            default:
                return true;
        }
    }

    validateSecureInstanceAgainstSchema(instanceJson, fields, fieldCount) {
        if (!instanceJson || !fields || fieldCount <= 0) {
            return -1;
        }

        for (let i = 0; i < fieldCount; i++) {
            if (fields[i].required && !this.jsonHasField(instanceJson, fields[i].name)) {
                if (this.verboseMode) {
                    console.error(`Validation error: Required field '${fields[i].name}' is missing`);
                }
                return -1;
            }

            if (this.jsonHasField(instanceJson, fields[i].name)) {
                const fieldValue = this.jsonGetStringValue(instanceJson, fields[i].name);
                if (fieldValue) {
                    if (!this.validateSecureFieldValueAgainstSchema(fields[i].name, fieldValue, fields[i].type)) {
                        return -1;
                    }
                }
            }
        }
        return 0;
    }

    // ==================== SECURE DATABASE OPERATIONS ====================
    // MUST MATCH C VERSION EXACTLY

    async databaseSecureExists(databaseName) {
        if (!this.validateDatabaseName(databaseName)) return false;

        const basePath = this.getSecureSydbBaseDirectoryPath();
        const databasePath = path.join(basePath, databaseName);

        try {
            await fs.promises.access(databasePath);
            const stats = await fs.promises.stat(databasePath);
            return stats.isDirectory();
        } catch (error) {
            return false;
        }
    }

    async collectionSecureExists(databaseName, collectionName) {
        if (!this.validateDatabaseName(databaseName) || !this.validateCollectionName(collectionName)) {
            return false;
        }

        const basePath = this.getSecureSydbBaseDirectoryPath();
        const collectionPath = path.join(basePath, databaseName, collectionName);

        try {
            await fs.promises.access(collectionPath);
            const stats = await fs.promises.stat(collectionPath);
            return stats.isDirectory();
        } catch (error) {
            return false;
        }
    }

    async createSecureDatabase(databaseName) {
        if (!this.validateDatabaseName(databaseName)) {
            if (this.verboseMode) {
                console.error(`Error: Invalid database name '${databaseName}'`);
            }
            return -1;
        }

        const basePath = this.getSecureSydbBaseDirectoryPath();

        await this.createSecureDirectoryRecursively(basePath);

        const databasePath = path.join(basePath, databaseName);

        try {
            await fs.promises.access(databasePath);
            const stats = await fs.promises.stat(databasePath);
            if (stats.isDirectory()) {
                if (this.verboseMode) {
                    console.error(`Error: Database '${databaseName}' already exists`);
                }
                return -1;
            } else {
                await fs.promises.unlink(databasePath);
            }
        } catch (error) {
            // Doesn't exist, continue
        }

        let retries = 3;
        while (retries > 0) {
            try {
                await fs.promises.mkdir(databasePath, { mode: 0o755 });

                await fs.promises.access(databasePath);
                const stats = await fs.promises.stat(databasePath);
                if (stats.isDirectory()) {
                    if (this.verboseMode) {
                        console.log(`Database '${databaseName}' created successfully at ${databasePath}`);
                    }
                    return 0;
                }
            } catch (error) {
                retries--;
                if (retries > 0) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                } else {
                    if (this.verboseMode) {
                        console.error(`Error: Failed to create database '${databaseName}' after retries`);
                    }
                }
            }
        }

        return -1;
    }

    async listAllSecureDatabases() {
        const basePath = this.getSecureSydbBaseDirectoryPath();

        try {
            await fs.promises.access(basePath);
        } catch (error) {
            return [];
        }

        try {
            const files = await fs.promises.readdir(basePath);
            const databases = [];

            for (const file of files) {
                try {
                    const filePath = path.join(basePath, file);
                    const stats = await fs.promises.stat(filePath);

                    if (stats.isDirectory() &&
                        file !== '.' &&
                        file !== '..' &&
                        this.validateDatabaseName(file)) {
                        databases.push(file);
                    }
                } catch (error) {
                    // Skip errors
                }
            }

            return databases;
        } catch (error) {
            return [];
        }
    }

    // ==================== SECURE COLLECTION OPERATIONS ====================
    // MUST MATCH C VERSION EXACTLY

    async createSecureCollection(databaseName, collectionName, fields, fieldCount) {
        if (!this.validateDatabaseName(databaseName) ||
            !this.validateCollectionName(collectionName) ||
            !fields || fieldCount <= 0) {
            if (this.verboseMode) {
                console.error('Error: Invalid database, collection name, or fields');
            }
            return -1;
        }

        if (!(await this.databaseSecureExists(databaseName))) {
            if (this.verboseMode) {
                console.error(`Database '${databaseName}' does not exist`);
            }
            return -1;
        }

        if (await this.collectionSecureExists(databaseName, collectionName)) {
            if (this.verboseMode) {
                console.error(`Collection '${collectionName}' already exists in database '${databaseName}'`);
            }
            return -1;
        }

        const basePath = this.getSecureSydbBaseDirectoryPath();
        const collectionPath = path.join(basePath, databaseName, collectionName);

        try {
            await this.createSecureDirectoryRecursively(collectionPath);

            const schemaFilePath = path.join(collectionPath, 'schema.txt');
            let schemaContent = '';

            for (let i = 0; i < fieldCount; i++) {
                const field = fields[i];
                schemaContent += `${field.name}:${this.convertSecureFieldTypeToString(field.type)}:` +
                               `${field.required ? 'required' : 'optional'}:` +
                               `${field.indexed ? 'indexed' : 'unindexed'}\n`;
            }

            await fs.promises.writeFile(schemaFilePath, schemaContent, 'utf8');

            const dataFile = await this.openSecureDataFileWithOptimizations(databaseName, collectionName, 'w+');

            if (dataFile) {
                await this.initializeSecureHighPerformanceDataFile(dataFile);
                dataFile.close();
            }

            if (this.verboseMode) {
                console.log(`Collection '${collectionName}' created successfully in database '${databaseName}'`);
            }
            return 0;
        } catch (error) {
            if (this.verboseMode) {
                console.error('Error creating collection:', error);
            }
            return -1;
        }
    }

    async listSecureCollectionsInDatabase(databaseName) {
        if (!this.validateDatabaseName(databaseName)) {
            return [];
        }

        if (!(await this.databaseSecureExists(databaseName))) {
            return [];
        }

        const basePath = this.getSecureSydbBaseDirectoryPath();
        const databasePath = path.join(basePath, databaseName);

        try {
            const files = await fs.promises.readdir(databasePath);
            const collections = [];

            for (const file of files) {
                try {
                    const filePath = path.join(databasePath, file);
                    const stats = await fs.promises.stat(filePath);

                    if (stats.isDirectory() &&
                        file !== '.' &&
                        file !== '..' &&
                        this.validateCollectionName(file)) {
                        collections.push(file);
                    }
                } catch (error) {
                    // Skip errors
                }
            }

            return collections;
        } catch (error) {
            return [];
        }
    }

    // ==================== SECURE INSTANCE OPERATIONS ====================
    // MUST MATCH C VERSION EXACTLY

    buildSecureInstanceJsonFromFieldsAndValues(fieldNames, fieldValues, fieldCount) {
        if (!fieldNames || !fieldValues || fieldCount <= 0 || fieldCount > JS_SyDB.MAXIMUM_FIELDS) {
            return null;
        }

        const fields = [];
        for (let i = 0; i < fieldCount; i++) {
            if (!fieldNames[i] || !this.validateFieldName(fieldNames[i])) {
                continue;
            }

            if (!fieldValues[i] || fieldValues[i].length === 0) {
                continue;
            }

            const value = fieldValues[i];
            if ((value[0] === '[' && value[value.length - 1] === ']') ||
                (value[0] === '{' && value[value.length - 1] === '}')) {
                fields.push(`"${fieldNames[i]}":${value}`);
            } else {
                const num = Number(value);
                if (!isNaN(num) && value.trim() === String(num)) {
                    fields.push(`"${fieldNames[i]}":${value}`);
                } else {
                    fields.push(`"${fieldNames[i]}":"${value}"`);
                }
            }
        }

        if (fields.length === 0) return null;
        return `{${fields.join(',')}}`;
    }

    async insertSecureInstanceIntoCollection(databaseName, collectionName, instanceJson) {
        if (!this.validateDatabaseName(databaseName) ||
            !this.validateCollectionName(collectionName) ||
            !instanceJson) {
            if (this.verboseMode) {
                console.error('Error: Invalid database, collection name, or instance JSON');
            }
            return -1;
        }

        if (!(await this.databaseSecureExists(databaseName)) ||
            !(await this.collectionSecureExists(databaseName, collectionName))) {
            if (this.verboseMode) {
                console.error('Database or collection does not exist');
            }
            return -1;
        }

        let uuid = this.jsonGetStringValue(instanceJson, "_id");
        if (!uuid) {
            uuid = this.generateSecureUniversallyUniqueIdentifier();
        }

        const timestamp = Math.floor(Date.now() / 1000);

        let completeJson;
        try {
            const instanceObj = JSON.parse(instanceJson);
            if (!instanceObj._id) {
                instanceObj._id = uuid;
            }
            if (!instanceObj._created_at) {
                instanceObj._created_at = timestamp;
            }
            completeJson = JSON.stringify(instanceObj);
        } catch (error) {
            if (instanceJson.startsWith('{') && instanceJson.endsWith('}')) {
                const jsonWithoutBraces = instanceJson.substring(1, instanceJson.length - 1);
                completeJson = `{"_id":"${uuid}","_created_at":${timestamp},${jsonWithoutBraces}}`;
            } else {
                completeJson = `{"_id":"${uuid}","_created_at":${timestamp},"data":${JSON.stringify(instanceJson)}}`;
            }
        }

        const dataLength = Buffer.byteLength(completeJson);
        const totalRecordSize = JS_SyDB.RECORD_HEADER_SIZE + dataLength + 1;

        try {
            const dataFile = await this.openSecureDataFileWithOptimizations(databaseName, collectionName, 'r+');
            if (!dataFile) {
                if (this.verboseMode) {
                    console.error('Failed to open data file');
                }
                return -1;
            }

            let fileHeader = this.readSecureFileHeaderInformation(dataFile);
            if (!fileHeader) {
                await this.initializeSecureHighPerformanceDataFile(dataFile);
                fileHeader = this.readSecureFileHeaderInformation(dataFile);
            }

            if (!fileHeader) {
                dataFile.close();
                return -1;
            }

            // Prepare record buffer
            const recordBuffer = Buffer.alloc(totalRecordSize);
            // data_size
            recordBuffer.writeBigUInt64LE(BigInt(dataLength), 0);
            // timestamp
            recordBuffer.writeBigUInt64LE(BigInt(timestamp), 8);
            // flags
            recordBuffer.writeUInt32LE(0, 16);
            // data_checksum
            recordBuffer.writeUInt32LE(this.computeCrc32Checksum(completeJson), 20);
            // field_count
            recordBuffer.writeUInt32LE(0, 24);
            // uuid (37 bytes including null terminator)
            const uuidBuffer = Buffer.from(uuid + '\0');
            uuidBuffer.copy(recordBuffer, 28);
            // reserved (20 bytes) already zero
            // padding (3 bytes) already zero
            // data
            const dataBuffer = Buffer.from(completeJson + '\0');
            dataBuffer.copy(recordBuffer, JS_SyDB.RECORD_HEADER_SIZE);

            fs.writeSync(dataFile.fd, recordBuffer, 0, totalRecordSize, fileHeader.freeOffset);

            fileHeader.recordCount++;
            fileHeader.freeOffset += totalRecordSize;
            fileHeader.fileSize = Math.max(fileHeader.fileSize, fileHeader.freeOffset);
            this.writeSecureFileHeaderInformation(dataFile, fileHeader);

            dataFile.close();

            if (this.verboseMode) {
                console.log(`Instance inserted successfully with ID: ${uuid}`);
            }
            return 0;
        } catch (error) {
            if (this.verboseMode) {
                console.error('Error inserting instance:', error);
            }
            return -1;
        }
    }

    // ==================== SECURE QUERY OPERATIONS ====================
    // MUST MATCH C VERSION EXACTLY

    async findSecureInstancesWithQuery(databaseName, collectionName, query) {
        if (!this.validateDatabaseName(databaseName) || !this.validateCollectionName(collectionName)) {
            return [];
        }

        if (!(await this.databaseSecureExists(databaseName)) ||
            !(await this.collectionSecureExists(databaseName, collectionName))) {
            if (this.verboseMode) {
                console.error('Database or collection does not exist');
            }
            return [];
        }

        try {
            const dataFile = await this.openSecureDataFileWithOptimizations(databaseName, collectionName, 'r');
            if (!dataFile) {
                return [];
            }

            const fileHeader = this.readSecureFileHeaderInformation(dataFile);
            if (!fileHeader || fileHeader.recordCount === 0) {
                dataFile.close();
                return [];
            }

            const results = [];
            let currentOffset = JS_SyDB.FILE_HEADER_SIZE;

            for (let i = 0; i < fileHeader.recordCount; i++) {
                const headerBuffer = Buffer.alloc(JS_SyDB.RECORD_HEADER_SIZE);
                const bytesRead = fs.readSync(dataFile.fd, headerBuffer, 0, JS_SyDB.RECORD_HEADER_SIZE, currentOffset);

                if (bytesRead !== JS_SyDB.RECORD_HEADER_SIZE) {
                    break;
                }

                const dataSize = Number(headerBuffer.readBigUInt64LE(0));
                const totalRecordSize = JS_SyDB.RECORD_HEADER_SIZE + dataSize + 1;

                const dataBuffer = Buffer.alloc(dataSize + 1);
                fs.readSync(dataFile.fd, dataBuffer, 0, dataSize + 1, currentOffset + JS_SyDB.RECORD_HEADER_SIZE);

                const jsonData = dataBuffer.toString('utf8', 0, dataSize);

                if (this.jsonMatchesQueryConditions(jsonData, query)) {
                    results.push(jsonData);
                }

                currentOffset += totalRecordSize;

                if (currentOffset >= fileHeader.fileSize) {
                    break;
                }
            }

            dataFile.close();
            return results;
        } catch (error) {
            if (this.verboseMode) {
                console.error('Error finding instances:', error);
            }
            return [];
        }
    }

    async listAllSecureInstancesInCollection(databaseName, collectionName) {
        return this.findSecureInstancesWithQuery(databaseName, collectionName, '');
    }

    // ==================== SECURE UPDATE OPERATIONS ====================
    // MUST MATCH C VERSION EXACTLY

    async updateSecureInstanceInCollection(databaseName, collectionName, instanceId, updateJson) {
        if (!this.validateDatabaseName(databaseName) || !this.validateCollectionName(collectionName) ||
            !instanceId || !updateJson) {
            if (this.verboseMode) {
                console.error('Error: Invalid parameters');
            }
            return -1;
        }

        if (!(await this.databaseSecureExists(databaseName))) {
            await this.createSecureDatabase(databaseName);
        }

        if (!(await this.collectionSecureExists(databaseName, collectionName))) {
            const defaultFields = [{ name: "data", type: JS_SyDB.FIELD_TYPE.STRING, required: false, indexed: false }];
            await this.createSecureCollection(databaseName, collectionName, defaultFields, 1);
        }

        try {
            const dataFile = await this.openSecureDataFileWithOptimizations(databaseName, collectionName, 'r+');
            if (!dataFile) {
                dataFile = await this.openSecureDataFileWithOptimizations(databaseName, collectionName, 'w+');
                if (!dataFile) return -1;
                await this.initializeSecureHighPerformanceDataFile(dataFile);
            }

            let fileHeader = this.readSecureFileHeaderInformation(dataFile);
            if (!fileHeader) {
                await this.initializeSecureHighPerformanceDataFile(dataFile);
                fileHeader = this.readSecureFileHeaderInformation(dataFile);
            }

            if (!fileHeader) {
                dataFile.close();
                return -1;
            }

            let currentOffset = JS_SyDB.FILE_HEADER_SIZE;
            let found = false;
            let targetOffset = 0;
            let targetSize = 0;
            let originalData = null;

            for (let i = 0; i < fileHeader.recordCount; i++) {
                const headerBuffer = Buffer.alloc(JS_SyDB.RECORD_HEADER_SIZE);
                const bytesRead = fs.readSync(dataFile.fd, headerBuffer, 0, JS_SyDB.RECORD_HEADER_SIZE, currentOffset);

                if (bytesRead !== JS_SyDB.RECORD_HEADER_SIZE) break;

                const dataSize = Number(headerBuffer.readBigUInt64LE(0));
                const totalRecordSize = JS_SyDB.RECORD_HEADER_SIZE + dataSize + 1;

                const dataBuffer = Buffer.alloc(dataSize + 1);
                fs.readSync(dataFile.fd, dataBuffer, 0, dataSize + 1, currentOffset + JS_SyDB.RECORD_HEADER_SIZE);
                const jsonData = dataBuffer.toString('utf8', 0, dataSize);

                if (jsonData.includes(`"_id":"${instanceId}"`)) {
                    found = true;
                    targetOffset = currentOffset;
                    targetSize = totalRecordSize;
                    originalData = jsonData;
                    break;
                }

                currentOffset += totalRecordSize;
                if (currentOffset >= fileHeader.fileSize) break;
            }

            if (!found) {
                dataFile.close();
                if (this.verboseMode) {
                    console.log(`Instance updated successfully with ID: ${instanceId}`);
                }
                return 0;
            }

            let updatedJson;
            try {
                const originalObj = JSON.parse(originalData);
                const updateObj = JSON.parse(updateJson);
                const mergedObj = { ...originalObj, ...updateObj };
                mergedObj._id = instanceId;
                if (originalObj._created_at) {
                    mergedObj._created_at = originalObj._created_at;
                }
                updatedJson = JSON.stringify(mergedObj);
            } catch (error) {
                updatedJson = originalData;
                dataFile.close();
                return 0;
            }

            const newDataLength = Buffer.byteLength(updatedJson);
            const newTotalSize = JS_SyDB.RECORD_HEADER_SIZE + newDataLength + 1;

            const remainingSize = fileHeader.fileSize - (targetOffset + targetSize);
            let remainingData = null;

            if (remainingSize > 0) {
                remainingData = Buffer.alloc(remainingSize);
                fs.readSync(dataFile.fd, remainingData, 0, remainingSize, targetOffset + targetSize);
            }

            const newRecordBuffer = Buffer.alloc(newTotalSize);
            // data_size
            newRecordBuffer.writeBigUInt64LE(BigInt(newDataLength), 0);
            // timestamp (update timestamp)
            newRecordBuffer.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000)), 8);
            // flags
            newRecordBuffer.writeUInt32LE(0, 16);
            // data_checksum
            newRecordBuffer.writeUInt32LE(this.computeCrc32Checksum(updatedJson), 20);
            // field_count
            newRecordBuffer.writeUInt32LE(0, 24);
            // uuid
            const uuidBuffer = Buffer.from(instanceId + '\0');
            uuidBuffer.copy(newRecordBuffer, 28);
            // reserved (20 bytes) already zero
            // padding (3 bytes) already zero
            // data
            const dataBuffer = Buffer.from(updatedJson + '\0');
            dataBuffer.copy(newRecordBuffer, JS_SyDB.RECORD_HEADER_SIZE);

            fs.writeSync(dataFile.fd, newRecordBuffer, 0, newTotalSize, targetOffset);
            if (remainingData && remainingSize > 0) {
                fs.writeSync(dataFile.fd, remainingData, 0, remainingSize, targetOffset + newTotalSize);
            }

            const newFileSize = targetOffset + newTotalSize + remainingSize;
            if (newFileSize !== fileHeader.fileSize) {
                fs.ftruncateSync(dataFile.fd, newFileSize);
                fileHeader.fileSize = newFileSize;
                fileHeader.freeOffset = newFileSize;
            }

            this.writeSecureFileHeaderInformation(dataFile, fileHeader);
            dataFile.close();

            if (this.verboseMode) {
                console.log(`Instance updated successfully with ID: ${instanceId}`);
            }
            return 0;
        } catch (error) {
            if (this.verboseMode) {
                console.error('Error updating instance:', error);
            }
            return -1;
        }
    }

    // ==================== SECURE DELETE OPERATIONS ====================
    // MUST MATCH C VERSION EXACTLY

    async deleteSecureInstanceFromCollection(databaseName, collectionName, instanceId) {
        if (!this.validateDatabaseName(databaseName) || !this.validateCollectionName(collectionName) || !instanceId) {
            if (this.verboseMode) {
                console.error('Error: Invalid parameters');
            }
            return -1;
        }

        if (!(await this.databaseSecureExists(databaseName)) ||
            !(await this.collectionSecureExists(databaseName, collectionName))) {
            if (this.verboseMode) {
                console.error('Error: Database or collection does not exist');
            }
            return -1;
        }

        try {
            const dataFile = await this.openSecureDataFileWithOptimizations(databaseName, collectionName, 'r+');
            if (!dataFile) {
                return -1;
            }

            let fileHeader = this.readSecureFileHeaderInformation(dataFile);
            if (!fileHeader) {
                dataFile.close();
                return -1;
            }

            let currentOffset = JS_SyDB.FILE_HEADER_SIZE;
            let found = false;
            let targetOffset = 0;
            let targetSize = 0;

            for (let i = 0; i < fileHeader.recordCount; i++) {
                const headerBuffer = Buffer.alloc(JS_SyDB.RECORD_HEADER_SIZE);
                const bytesRead = fs.readSync(dataFile.fd, headerBuffer, 0, JS_SyDB.RECORD_HEADER_SIZE, currentOffset);

                if (bytesRead !== JS_SyDB.RECORD_HEADER_SIZE) break;

                const dataSize = Number(headerBuffer.readBigUInt64LE(0));
                const totalRecordSize = JS_SyDB.RECORD_HEADER_SIZE + dataSize + 1;

                const dataBuffer = Buffer.alloc(dataSize + 1);
                fs.readSync(dataFile.fd, dataBuffer, 0, dataSize + 1, currentOffset + JS_SyDB.RECORD_HEADER_SIZE);
                const jsonData = dataBuffer.toString('utf8', 0, dataSize);

                if (jsonData.includes(`"_id":"${instanceId}"`)) {
                    found = true;
                    targetOffset = currentOffset;
                    targetSize = totalRecordSize;
                    break;
                }

                currentOffset += totalRecordSize;
                if (currentOffset >= fileHeader.fileSize) break;
            }

            if (!found) {
                dataFile.close();
                if (this.verboseMode) {
                    console.error(`Error: Instance with ID ${instanceId} not found`);
                }
                return -1;
            }

            const remainingSize = fileHeader.fileSize - (targetOffset + targetSize);

            if (remainingSize > 0) {
                const remainingData = Buffer.alloc(remainingSize);
                fs.readSync(dataFile.fd, remainingData, 0, remainingSize, targetOffset + targetSize);

                fs.writeSync(dataFile.fd, remainingData, 0, remainingSize, targetOffset);

                const newSize = targetOffset + remainingSize;
                fs.ftruncateSync(dataFile.fd, newSize);
                fileHeader.fileSize = newSize;
                fileHeader.freeOffset = newSize;
            } else {
                fs.ftruncateSync(dataFile.fd, targetOffset);
                fileHeader.fileSize = targetOffset;
                fileHeader.freeOffset = targetOffset;
            }

            fileHeader.recordCount--;
            this.writeSecureFileHeaderInformation(dataFile, fileHeader);
            dataFile.close();

            if (this.verboseMode) {
                console.log(`Instance deleted successfully with ID: ${instanceId}`);
            }
            return 0;
        } catch (error) {
            if (this.verboseMode) {
                console.error('Error deleting instance:', error);
            }
            return -1;
        }
    }

    // ==================== HTTP API IMPLEMENTATION ====================
    // MUST MATCH C VERSION EXACTLY

    async httpApiListDatabases() {
        const databases = await this.listAllSecureDatabases();
        const databasesJson = this.buildJsonArrayHighPerformance(databases);
        return this.createSuccessResponseWithData('databases', databasesJson);
    }

    async httpApiCreateDatabase(databaseName) {
        if (!databaseName || databaseName.length === 0) {
            return this.createErrorResponse('Database name is required');
        }

        if (!this.validateDatabaseName(databaseName)) {
            return this.createErrorResponse('Invalid database name');
        }

        const result = await this.createSecureDatabase(databaseName);

        if (result === 0) {
            return this.createSuccessResponse('Database created successfully');
        } else {
            const basePath = this.getSecureSydbBaseDirectoryPath();
            const databasePath = path.join(basePath, databaseName);

            try {
                const stats = await fs.promises.stat(databasePath);
                if (stats.isDirectory()) {
                    return this.createErrorResponse('Database already exists');
                }
            } catch (error) {
                // Database doesn't exist
            }
            return this.createErrorResponse('Failed to create database');
        }
    }

    async httpApiDeleteDatabase(databaseName) {
        if (!databaseName || databaseName.length === 0) {
            return this.createErrorResponse('Database name is required');
        }

        if (!this.validateDatabaseName(databaseName)) {
            return this.createErrorResponse('Invalid database name');
        }

        const basePath = this.getSecureSydbBaseDirectoryPath();
        const databasePath = path.join(basePath, databaseName);

        try {
            await fs.promises.access(databasePath);
            const stats = await fs.promises.stat(databasePath);
            if (!stats.isDirectory()) {
                return this.createSuccessResponse('Database deleted successfully');
            }
        } catch (error) {
            return this.createSuccessResponse('Database deleted successfully');
        }

        try {
            const { exec } = await import('child_process');
            const util = await import('util');
            const execPromise = util.promisify(exec);

            await execPromise(`rm -rf "${databasePath}" 2>/dev/null`);
            return this.createSuccessResponse('Database deleted successfully');
        } catch (error) {
            return this.createErrorResponse('Failed to delete database');
        }
    }

    async httpApiListCollections(databaseName) {
        if (!databaseName || databaseName.length === 0) {
            return this.createErrorResponse('Database name is required');
        }

        if (!this.validateDatabaseName(databaseName)) {
            return this.createErrorResponse('Invalid database name');
        }

        if (!(await this.databaseSecureExists(databaseName))) {
            return this.createErrorResponse('Database does not exist');
        }

        const collections = await this.listSecureCollectionsInDatabase(databaseName);
        const collectionsJson = this.buildJsonArrayHighPerformance(collections);
        return this.createSuccessResponseWithData('collections', collectionsJson);
    }

    async httpApiCreateCollection(databaseName, requestBody) {
        if (!databaseName || databaseName.length === 0) {
            return this.createErrorResponse('Database name is required');
        }

        if (!requestBody || requestBody.length === 0) {
            return this.createErrorResponse('Request body is required');
        }

        if (!this.validateDatabaseName(databaseName)) {
            return this.createErrorResponse('Invalid database name');
        }

        if (!(await this.databaseSecureExists(databaseName))) {
            return this.createErrorResponse('Database does not exist');
        }

        try {
            const request = JSON.parse(requestBody);
            const collectionName = request.name;

            if (!collectionName || collectionName.length === 0) {
                return this.createErrorResponse('Collection name is required');
            }

            if (!this.validateCollectionName(collectionName)) {
                return this.createErrorResponse('Invalid collection name');
            }

            if (await this.collectionSecureExists(databaseName, collectionName)) {
                return this.createErrorResponse('Collection already exists');
            }

            const schema = request.schema;
            if (!schema || !Array.isArray(schema)) {
                return this.createErrorResponse('Invalid schema format: missing "schema" field');
            }

            const fields = [];
            for (const fieldSchema of schema) {
                const field = {
                    name: fieldSchema.name,
                    type: this.parseSecureFieldTypeFromString(fieldSchema.type),
                    required: fieldSchema.required === true,
                    indexed: fieldSchema.indexed === true
                };
                fields.push(field);
            }

            if (fields.length === 0) {
                return this.createErrorResponse('No valid fields found in schema');
            }

            const result = await this.createSecureCollection(databaseName, collectionName, fields, fields.length);
            if (result === 0) {
                return this.createSuccessResponse('Collection created successfully');
            } else {
                return this.createErrorResponse('Failed to create collection');
            }
        } catch (error) {
            return this.createErrorResponse('Invalid request format');
        }
    }

    async httpApiDeleteCollection(databaseName, collectionName) {
        if (!databaseName || databaseName.length === 0) {
            return this.createErrorResponse('Database name is required');
        }

        if (!collectionName || collectionName.length === 0) {
            return this.createErrorResponse('Collection name is required');
        }

        if (!this.validateDatabaseName(databaseName)) {
            return this.createErrorResponse('Invalid database name');
        }

        if (!this.validateCollectionName(collectionName)) {
            return this.createErrorResponse('Invalid collection name');
        }

        const basePath = this.getSecureSydbBaseDirectoryPath();
        const collectionPath = path.join(basePath, databaseName, collectionName);

        try {
            const { exec } = await import('child_process');
            const util = await import('util');
            const execPromise = util.promisify(exec);

            await execPromise(`rm -rf "${collectionPath}" 2>/dev/null`);
            return this.createSuccessResponse('Collection deleted successfully');
        } catch (error) {
            return this.createSuccessResponse('Collection deleted successfully');
        }
    }

    async httpApiGetCollectionSchema(databaseName, collectionName) {
        if (!databaseName || databaseName.length === 0) {
            return this.createErrorResponse('Database name is required');
        }

        if (!collectionName || collectionName.length === 0) {
            return this.createErrorResponse('Collection name is required');
        }

        if (!this.validateDatabaseName(databaseName)) {
            return this.createErrorResponse('Invalid database name');
        }

        if (!this.validateCollectionName(collectionName)) {
            return this.createErrorResponse('Invalid collection name');
        }

        if (!(await this.databaseSecureExists(databaseName)) ||
            !(await this.collectionSecureExists(databaseName, collectionName))) {
            return this.createErrorResponse('Database or collection does not exist');
        }

        const basePath = this.getSecureSydbBaseDirectoryPath();
        const schemaFilePath = path.join(basePath, databaseName, collectionName, 'schema.txt');

        try {
            const schemaContent = await fs.promises.readFile(schemaFilePath, 'utf8');
            const lines = schemaContent.split('\n').filter(line => line.trim());

            const fields = [];
            for (const line of lines) {
                const parts = line.split(':');
                if (parts.length >= 4) {
                    const field = {
                        name: parts[0],
                        type: parts[1],
                        required: parts[2] === 'required',
                        indexed: parts[3] === 'indexed'
                    };
                    fields.push(field);
                }
            }

            const fieldsJson = JSON.stringify(fields);
            const schemaJson = `{"fields":${fieldsJson}}`;
            return this.createSuccessResponseWithData('schema', schemaJson);
        } catch (error) {
            return this.createErrorResponse('Failed to load schema');
        }
    }

    async httpApiListInstances(databaseName, collectionName, query) {
        if (!databaseName || databaseName.length === 0) {
            return this.createErrorResponse('Database name is required');
        }

        if (!collectionName || collectionName.length === 0) {
            return this.createErrorResponse('Collection name is required');
        }

        if (!this.validateDatabaseName(databaseName)) {
            return this.createErrorResponse('Invalid database name');
        }

        if (!this.validateCollectionName(collectionName)) {
            return this.createErrorResponse('Invalid collection name');
        }

        let instances;
        if (query && query.length > 0) {
            const decodedQuery = this.urlDecode(query);
            instances = await this.findSecureInstancesWithQuery(databaseName, collectionName, decodedQuery);
        } else {
            instances = await this.listAllSecureInstancesInCollection(databaseName, collectionName);
        }

        const instancesJson = this.buildJsonArrayHighPerformance(instances);
        return this.createSuccessResponseWithData('instances', instancesJson);
    }

    async httpApiInsertInstance(databaseName, collectionName, instanceJson) {
        if (!databaseName || databaseName.length === 0) {
            return this.createErrorResponse('Database name is required');
        }

        if (!collectionName || collectionName.length === 0) {
            return this.createErrorResponse('Collection name is required');
        }

        if (!instanceJson || instanceJson.length === 0) {
            return this.createErrorResponse('Instance data is required');
        }

        if (!this.validateDatabaseName(databaseName)) {
            return this.createErrorResponse('Invalid database name');
        }

        if (!this.validateCollectionName(collectionName)) {
            return this.createErrorResponse('Invalid collection name');
        }

        if (!(await this.databaseSecureExists(databaseName))) {
            if (this.verboseMode) {
                console.log(`Database doesn't exist, creating: ${databaseName}`);
            }
            await this.createSecureDatabase(databaseName);
        }

        if (!(await this.collectionSecureExists(databaseName, collectionName))) {
            if (this.verboseMode) {
                console.log(`Collection doesn't exist, creating: ${collectionName}`);
            }
            const defaultFields = [];
            try {
                const instanceObj = JSON.parse(instanceJson);
                for (const key in instanceObj) {
                    if (key !== '_id' && key !== '_created_at') {
                        defaultFields.push({
                            name: key,
                            type: JS_SyDB.FIELD_TYPE.STRING,
                            required: false,
                            indexed: false
                        });
                    }
                }
            } catch (error) {
                defaultFields.push({
                    name: "data",
                    type: JS_SyDB.FIELD_TYPE.STRING,
                    required: false,
                    indexed: false
                });
            }

            if (defaultFields.length === 0) {
                defaultFields.push({
                    name: "data",
                    type: JS_SyDB.FIELD_TYPE.STRING,
                    required: false,
                    indexed: false
                });
            }

            await this.createSecureCollection(databaseName, collectionName, defaultFields, defaultFields.length);
        }

        let uuid = this.jsonGetStringValue(instanceJson, "_id");
        let finalInstanceJson = instanceJson;

        if (!uuid) {
            uuid = this.generateSecureUniversallyUniqueIdentifier();
            try {
                const instanceObj = JSON.parse(instanceJson);
                instanceObj._id = uuid;
                finalInstanceJson = JSON.stringify(instanceObj);
            } catch (error) {
                if (instanceJson.startsWith('{') && instanceJson.endsWith('}')) {
                    const jsonWithoutBraces = instanceJson.substring(1, instanceJson.length - 1);
                    finalInstanceJson = `{"_id":"${uuid}",${jsonWithoutBraces}}`;
                } else {
                    finalInstanceJson = `{"_id":"${uuid}","data":${JSON.stringify(instanceJson)}}`;
                }
            }
        }

        const result = await this.insertSecureInstanceIntoCollection(databaseName, collectionName, finalInstanceJson);

        if (result === 0) {
            return `{"success":true,"id":"${uuid}","message":"Instance created successfully"}`;
        } else {
            return this.createErrorResponse('Failed to insert instance into collection');
        }
    }

    async httpApiUpdateInstance(databaseName, collectionName, instanceId, updateJson) {
        if (!databaseName || databaseName.length === 0) {
            return this.createErrorResponse('Database name is required');
        }

        if (!collectionName || collectionName.length === 0) {
            return this.createErrorResponse('Collection name is required');
        }

        if (!instanceId || instanceId.length === 0) {
            return this.createErrorResponse('Instance ID is required');
        }

        if (!updateJson || updateJson.length === 0) {
            return this.createErrorResponse('Update data is required');
        }

        if (!this.validateDatabaseName(databaseName)) {
            return this.createErrorResponse('Invalid database name');
        }

        if (!this.validateCollectionName(collectionName)) {
            return this.createErrorResponse('Invalid collection name');
        }

        const result = await this.updateSecureInstanceInCollection(databaseName, collectionName, instanceId, updateJson);

        if (result === 0) {
            return this.createSuccessResponse('Instance updated successfully');
        } else {
            return this.createSuccessResponse('Instance updated successfully');
        }
    }

    async httpApiDeleteInstance(databaseName, collectionName, instanceId) {
        if (!databaseName || databaseName.length === 0) {
            return this.createErrorResponse('Database name is required');
        }

        if (!collectionName || collectionName.length === 0) {
            return this.createErrorResponse('Collection name is required');
        }

        if (!instanceId || instanceId.length === 0) {
            return this.createErrorResponse('Instance ID is required');
        }

        if (!this.validateDatabaseName(databaseName)) {
            return this.createErrorResponse('Invalid database name');
        }

        if (!this.validateCollectionName(collectionName)) {
            return this.createErrorResponse('Invalid collection name');
        }

        const result = await this.deleteSecureInstanceFromCollection(databaseName, collectionName, instanceId);

        if (result === 0) {
            return this.createSuccessResponse('Instance deleted successfully');
        } else {
            return this.createSuccessResponse('Instance deleted successfully');
        }
    }

    async httpApiExecuteCommand(commandJson) {
        if (!commandJson || commandJson.length === 0) {
            return this.createErrorResponse('Command JSON is required');
        }

        try {
            const request = JSON.parse(commandJson);
            const command = request.command;

            if (!command) {
                return this.createErrorResponse('Command field is required');
            }

            let result = '';

            if (command === 'list') {
                const databases = await this.listAllSecureDatabases();
                result = JSON.stringify(databases);
            } else if (command === 'schema') {
                const args = request.arguments || [];
                if (args.length >= 2) {
                    const schemaResult = await this.httpApiGetCollectionSchema(args[0], args[1]);
                    result = schemaResult;
                } else {
                    return this.createErrorResponse('Database and collection names required for schema command');
                }
            } else {
                result = `Command "${command}" executed`;
            }

            return `{"success":true,"result":${JSON.stringify(result)},"command":"${command}"}`;
        } catch (error) {
            return this.createErrorResponse('Invalid command format');
        }
    }

    // ==================== REAL-TIME SERVER METRICS ====================
    // Runtime-only data kept in memory and bound to the running server instance.
    // Nothing here changes the on-disk SYDB format.

    getMonotonicMilliseconds() {
        return Number(process.hrtime.bigint()) / 1e6;
    }

    roundMetricValue(value) {
        return Math.round(value * 1000) / 1000;
    }

    createLatencyAccumulator(sampleSize = 0) {
        return {
            count: 0,
            totalMilliseconds: 0,
            minimumMilliseconds: 0,
            maximumMilliseconds: 0,
            lastMilliseconds: 0,
            sampleSize: sampleSize,
            samples: [],
            sampleIndex: 0
        };
    }

    recordLatency(accumulator, duration) {
        if (accumulator.count === 0 || duration < accumulator.minimumMilliseconds) {
            accumulator.minimumMilliseconds = duration;
        }
        if (duration > accumulator.maximumMilliseconds) {
            accumulator.maximumMilliseconds = duration;
        }
        accumulator.count++;
        accumulator.totalMilliseconds += duration;
        accumulator.lastMilliseconds = duration;

        if (accumulator.sampleSize > 0) {
            accumulator.samples[accumulator.sampleIndex] = duration;
            accumulator.sampleIndex = (accumulator.sampleIndex + 1) % accumulator.sampleSize;
        }
    }

    summarizeLatency(accumulator) {
        const summary = {
            count: accumulator.count,
            average_ms: accumulator.count ? this.roundMetricValue(accumulator.totalMilliseconds / accumulator.count) : 0,
            min_ms: this.roundMetricValue(accumulator.minimumMilliseconds),
            max_ms: this.roundMetricValue(accumulator.maximumMilliseconds),
            last_ms: this.roundMetricValue(accumulator.lastMilliseconds)
        };

        if (accumulator.sampleSize > 0) {
            const sorted = accumulator.samples.slice().sort((a, b) => a - b);
            const percentile = (fraction) => sorted.length === 0 ? 0 :
                this.roundMetricValue(sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]);

            summary.sample_count = sorted.length;
            summary.median_ms = percentile(0.5);
            summary.p95_ms = percentile(0.95);
            summary.p99_ms = percentile(0.99);
        }

        return summary;
    }

    readEventLoopUtilization() {
        if (typeof performance !== 'undefined' && typeof performance.eventLoopUtilization === 'function') {
            return performance.eventLoopUtilization();
        }
        return null;
    }

    createServerMetrics(port) {
        const now = this.getMonotonicMilliseconds();
        return {
            instanceId: this.generateSecureUniversallyUniqueIdentifier(),
            port: port,
            startedAtEpochMilliseconds: Date.now(),
            startedAtMilliseconds: now,
            totals: {
                received: 0,
                completed: 0,
                successful: 0,
                failed: 0,
                aborted: 0,
                rateLimited: 0,
                monitoring: 0
            },
            activeRequests: new Set(),
            nextRequestNumber: 1,
            processingCount: 0,
            peakInProgress: 0,
            peakProcessing: 0,
            peakRequestsPerSecond: 0,
            secondBuckets: new Array(JS_SyDB.METRICS_HISTORY_SECONDS + 1).fill(null),
            processingLatency: this.createLatencyAccumulator(JS_SyDB.METRICS_LATENCY_SAMPLE_SIZE),
            totalLatency: this.createLatencyAccumulator(JS_SyDB.METRICS_LATENCY_SAMPLE_SIZE),
            operations: new Map(),
            collections: new Map(),
            methods: new Map(),
            statusCodes: new Map(),
            bodyBytesReceived: 0,
            bodyBytesSent: 0,
            recentErrors: [],
            resourceSample: {
                takenAtMilliseconds: now,
                cpuUsage: process.cpuUsage(),
                eventLoop: this.readEventLoopUtilization(),
                cpuPercent: 0,
                eventLoopPercent: 0
            },
            storageCache: null,
            storageCacheTakenAt: 0,
            storageScanPromise: null
        };
    }

    isMetricsApiPath(requestPath) {
        const cleanPath = requestPath.split('?')[0];
        return cleanPath === JS_SyDB.METRICS_API_PATH ||
               cleanPath.startsWith(`${JS_SyDB.METRICS_API_PATH}/`);
    }

    // Mirrors the decisions made by httpRouteRequest, for statistics only
    classifyRequestOperation(method, requestPath) {
        const target = { operation: 'unknown', databaseName: '', collectionName: '' };

        if (requestPath === '/api/databases') {
            if (method === 'GET') target.operation = 'list_databases';
            else if (method === 'POST') target.operation = 'create_database';
            return target;
        }

        if (requestPath === '/api/execute') {
            if (method === 'POST') target.operation = 'execute_command';
            return target;
        }

        const components = this.parseApiPathOptimized(requestPath);
        if (!components || !components.databaseName) {
            return target;
        }

        const { databaseName, collectionName, instanceId } = components;
        target.databaseName = databaseName;
        target.collectionName = collectionName;

        if (method === 'GET') {
            if (!collectionName && !instanceId) target.operation = 'list_collections';
            else if (collectionName && requestPath.includes('/schema')) target.operation = 'get_schema';
            else if (collectionName && !instanceId) {
                target.operation = /[?&]query=[^&]/.test(requestPath) ? 'find_instances' : 'list_instances';
            }
        } else if (method === 'POST') {
            if (collectionName && !instanceId) target.operation = 'insert_instance';
            else if (!collectionName && !instanceId) target.operation = 'create_collection';
        } else if (method === 'PUT') {
            if (collectionName && instanceId) target.operation = 'update_instance';
        } else if (method === 'DELETE') {
            if (collectionName && instanceId) target.operation = 'delete_instance';
            else if (collectionName) target.operation = 'delete_collection';
            else if (!instanceId) target.operation = 'delete_database';
        }

        return target;
    }

    getMetricsElapsedSeconds(metrics) {
        return Math.floor((this.getMonotonicMilliseconds() - metrics.startedAtMilliseconds) / 1000);
    }

    getCurrentMetricsBucket(metrics) {
        const second = this.getMetricsElapsedSeconds(metrics);
        const index = second % metrics.secondBuckets.length;
        let bucket = metrics.secondBuckets[index];

        if (!bucket || bucket.second !== second) {
            bucket = {
                second: second,
                completed: 0,
                failed: 0,
                processed: 0,
                processingMilliseconds: 0,
                totalMilliseconds: 0
            };
            metrics.secondBuckets[index] = bucket;
        }

        return bucket;
    }

    // Sums the last N complete seconds (the current, still running second is excluded)
    summarizeMetricsWindow(metrics, windowSeconds) {
        const currentSecond = this.getMetricsElapsedSeconds(metrics);
        const summary = {
            coveredSeconds: Math.min(windowSeconds, currentSecond, JS_SyDB.METRICS_HISTORY_SECONDS),
            completed: 0,
            failed: 0,
            processed: 0,
            processingMilliseconds: 0,
            totalMilliseconds: 0,
            perSecond: []
        };

        for (let offset = summary.coveredSeconds; offset >= 1; offset--) {
            const second = currentSecond - offset;
            let bucket = metrics.secondBuckets[second % metrics.secondBuckets.length];
            if (bucket && bucket.second !== second) bucket = null;

            summary.perSecond.push(bucket ? bucket.completed : 0);
            if (!bucket) continue;

            summary.completed += bucket.completed;
            summary.failed += bucket.failed;
            summary.processed += bucket.processed;
            summary.processingMilliseconds += bucket.processingMilliseconds;
            summary.totalMilliseconds += bucket.totalMilliseconds;
        }

        return summary;
    }

    beginRequestMetrics(req, res) {
        const metrics = this.serverMetrics;
        if (!metrics) return null;

        const requestUrl = req.url || '/';

        // Monitoring calls are counted apart so they do not distort the database statistics
        if (this.isMetricsApiPath(requestUrl)) {
            metrics.totals.monitoring++;
            return null;
        }

        const method = req.method || 'GET';
        const target = this.classifyRequestOperation(method, requestUrl);
        const tracker = {
            metrics: metrics,
            requestNumber: metrics.nextRequestNumber++,
            method: method,
            path: requestUrl.split('?')[0],
            operation: target.operation,
            databaseName: target.databaseName,
            collectionName: target.collectionName,
            startedAtMilliseconds: this.getMonotonicMilliseconds(),
            processingStartedAtMilliseconds: 0,
            processingMilliseconds: null,
            phase: 'receiving',
            connectionClosed: false,
            responseBody: ''
        };

        metrics.totals.received++;
        metrics.activeRequests.add(tracker);
        metrics.peakInProgress = Math.max(metrics.peakInProgress, metrics.activeRequests.size);

        res.on('finish', () => this.completeRequestMetrics(tracker, res.statusCode, false));
        res.on('close', () => this.completeRequestMetrics(tracker, res.statusCode, !res.writableFinished));

        return tracker;
    }

    startRequestProcessingMetrics(tracker, requestBody) {
        if (!tracker || tracker.phase !== 'receiving') return;

        const metrics = tracker.metrics;
        tracker.phase = 'processing';
        tracker.processingStartedAtMilliseconds = this.getMonotonicMilliseconds();
        metrics.bodyBytesReceived += Buffer.byteLength(requestBody);
        metrics.processingCount++;
        metrics.peakProcessing = Math.max(metrics.peakProcessing, metrics.processingCount);
    }

    endRequestProcessingMetrics(tracker, clientContext) {
        if (!tracker || tracker.phase !== 'processing') return;

        const metrics = tracker.metrics;
        const duration = this.getMonotonicMilliseconds() - tracker.processingStartedAtMilliseconds;

        tracker.phase = 'responding';
        tracker.processingMilliseconds = duration;
        tracker.responseBody = (clientContext.response && clientContext.response.body) || '';
        metrics.processingCount--;

        this.recordLatency(metrics.processingLatency, duration);
        const bucket = this.getCurrentMetricsBucket(metrics);
        bucket.processed++;
        bucket.processingMilliseconds += duration;

        // The client left while the database was still working on its request
        if (tracker.connectionClosed) {
            this.completeRequestMetrics(tracker, 0, true);
        }
    }

    getMetricsGroup(groups, key, maximumGroups = Infinity) {
        let group = groups.get(key);
        if (!group && groups.size < maximumGroups) {
            group = { requests: 0, errors: 0, latency: this.createLatencyAccumulator() };
            groups.set(key, group);
        }
        return group || null;
    }

    completeRequestMetrics(tracker, statusCode, aborted) {
        if (!tracker || tracker.phase === 'done') return;

        // Keep it counted as "processing" until the database work really ends
        if (tracker.phase === 'processing') {
            if (aborted) tracker.connectionClosed = true;
            return;
        }

        const metrics = tracker.metrics;
        tracker.phase = 'done';
        metrics.activeRequests.delete(tracker);

        if (aborted || tracker.connectionClosed) {
            metrics.totals.aborted++;
            return;
        }

        const duration = this.getMonotonicMilliseconds() - tracker.startedAtMilliseconds;
        const responseBody = tracker.responseBody;
        // Most API errors are answered with HTTP 200 and "success":false
        const failed = statusCode >= 400 ||
            (typeof responseBody === 'string' && responseBody.startsWith('{"success":false'));

        metrics.totals.completed++;
        if (failed) metrics.totals.failed++;
        else metrics.totals.successful++;
        if (statusCode === 429) metrics.totals.rateLimited++;

        this.recordLatency(metrics.totalLatency, duration);

        const bucket = this.getCurrentMetricsBucket(metrics);
        bucket.completed++;
        bucket.totalMilliseconds += duration;
        if (failed) bucket.failed++;
        metrics.peakRequestsPerSecond = Math.max(metrics.peakRequestsPerSecond, bucket.completed);

        metrics.bodyBytesSent += Buffer.byteLength(responseBody);
        metrics.methods.set(tracker.method, (metrics.methods.get(tracker.method) || 0) + 1);
        metrics.statusCodes.set(statusCode, (metrics.statusCodes.get(statusCode) || 0) + 1);

        const groups = [this.getMetricsGroup(metrics.operations, tracker.operation)];
        if (this.validateDatabaseName(tracker.databaseName) &&
            this.validateCollectionName(tracker.collectionName)) {
            groups.push(this.getMetricsGroup(
                metrics.collections,
                `${tracker.databaseName}/${tracker.collectionName}`,
                JS_SyDB.METRICS_MAXIMUM_TRACKED_COLLECTIONS
            ));
        }

        for (const group of groups) {
            if (!group) continue;
            group.requests++;
            if (failed) group.errors++;
            if (tracker.processingMilliseconds !== null) {
                this.recordLatency(group.latency, tracker.processingMilliseconds);
            }
        }

        if (failed) {
            let errorMessage = statusCode === 429 ? 'Rate limit exceeded' : `HTTP ${statusCode}`;
            try {
                errorMessage = JSON.parse(responseBody).error || errorMessage;
            } catch (error) {
                // Keep the generic message
            }

            metrics.recentErrors.unshift({
                timestamp: new Date().toISOString(),
                method: tracker.method,
                path: tracker.path,
                operation: tracker.operation,
                status_code: statusCode,
                error: errorMessage
            });
            if (metrics.recentErrors.length > JS_SyDB.METRICS_MAXIMUM_RECENT_ERRORS) {
                metrics.recentErrors.pop();
            }
        }
    }

    buildInstanceMetrics(metrics) {
        return {
            id: metrics.instanceId,
            status: this.runningFlag ? 'running' : 'stopped',
            pid: process.pid,
            port: metrics.port,
            node_version: process.version,
            platform: process.platform,
            base_directory: this.getSecureSydbBaseDirectoryPath(),
            started_at: new Date(metrics.startedAtEpochMilliseconds).toISOString(),
            uptime_seconds: this.roundMetricValue(
                (this.getMonotonicMilliseconds() - metrics.startedAtMilliseconds) / 1000
            )
        };
    }

    buildResourceMetrics(metrics) {
        const sample = metrics.resourceSample;
        const now = this.getMonotonicMilliseconds();
        const elapsed = now - sample.takenAtMilliseconds;

        // Refreshed at most once per second, so several monitors read stable values
        if (elapsed >= 1000) {
            const cpuDelta = process.cpuUsage(sample.cpuUsage);
            sample.cpuPercent = this.roundMetricValue((cpuDelta.user + cpuDelta.system) / 1000 / elapsed * 100);
            sample.cpuUsage = process.cpuUsage();

            const eventLoop = this.readEventLoopUtilization();
            if (eventLoop && sample.eventLoop) {
                sample.eventLoopPercent = this.roundMetricValue(
                    performance.eventLoopUtilization(eventLoop, sample.eventLoop).utilization * 100
                );
            }
            sample.eventLoop = eventLoop;
            sample.takenAtMilliseconds = now;
        }

        const memory = process.memoryUsage();
        return {
            cpu_percent: sample.cpuPercent,
            event_loop_utilization_percent: sample.eventLoop ? sample.eventLoopPercent : null,
            memory: {
                rss_bytes: memory.rss,
                heap_used_bytes: memory.heapUsed,
                heap_total_bytes: memory.heapTotal,
                external_bytes: memory.external
            }
        };
    }

    buildRequestMetrics(metrics) {
        const now = this.getMonotonicMilliseconds();
        const phases = { receiving: 0, processing: 0, responding: 0 };
        const activeList = [];

        for (const tracker of metrics.activeRequests) {
            phases[tracker.phase]++;
            if (activeList.length < JS_SyDB.METRICS_MAXIMUM_ACTIVE_LISTED) {
                activeList.push({
                    request_number: tracker.requestNumber,
                    method: tracker.method,
                    path: tracker.path,
                    operation: tracker.operation,
                    phase: tracker.phase,
                    elapsed_ms: this.roundMetricValue(now - tracker.startedAtMilliseconds)
                });
            }
        }

        return {
            in_progress: metrics.activeRequests.size,
            receiving: phases.receiving,
            processing: phases.processing,
            responding: phases.responding,
            peak_in_progress: metrics.peakInProgress,
            peak_processing: metrics.peakProcessing,
            total_received: metrics.totals.received,
            total_completed: metrics.totals.completed,
            total_successful: metrics.totals.successful,
            total_failed: metrics.totals.failed,
            total_aborted: metrics.totals.aborted,
            total_rate_limited: metrics.totals.rateLimited,
            total_monitoring: metrics.totals.monitoring,
            error_rate_percent: metrics.totals.completed ?
                this.roundMetricValue(metrics.totals.failed / metrics.totals.completed * 100) : 0,
            active: activeList
        };
    }

    buildPerformanceMetrics(metrics) {
        const uptimeSeconds = (this.getMonotonicMilliseconds() - metrics.startedAtMilliseconds) / 1000;
        const lastSecond = this.summarizeMetricsWindow(metrics, 1);
        const lastTenSeconds = this.summarizeMetricsWindow(metrics, 10);
        const lastMinute = this.summarizeMetricsWindow(metrics, 60);
        const lastFiveMinutes = this.summarizeMetricsWindow(metrics, 300);
        const lastFifteenMinutes = this.summarizeMetricsWindow(metrics, 900);

        const ratio = (total, divisor) => divisor > 0 ? this.roundMetricValue(total / divisor) : 0;
        // With less than one minute of data, report the real count instead of extrapolating
        const perMinute = (total, seconds) => this.roundMetricValue(total / Math.max(seconds / 60, 1));

        return {
            requests_per_second: {
                current: lastSecond.completed,
                average_last_10_seconds: ratio(lastTenSeconds.completed, lastTenSeconds.coveredSeconds),
                average_last_60_seconds: ratio(lastMinute.completed, lastMinute.coveredSeconds),
                average_since_start: ratio(metrics.totals.completed, Math.max(uptimeSeconds, 1)),
                peak: metrics.peakRequestsPerSecond
            },
            requests_per_minute: {
                last_minute: lastMinute.completed,
                average_last_5_minutes: perMinute(lastFiveMinutes.completed, lastFiveMinutes.coveredSeconds),
                average_last_15_minutes: perMinute(lastFifteenMinutes.completed, lastFifteenMinutes.coveredSeconds),
                average_since_start: perMinute(metrics.totals.completed, uptimeSeconds)
            },
            history_last_60_seconds: lastMinute.perSecond,
            processing_time: {
                ...this.summarizeLatency(metrics.processingLatency),
                average_last_60_seconds_ms: ratio(lastMinute.processingMilliseconds, lastMinute.processed)
            },
            total_time: {
                ...this.summarizeLatency(metrics.totalLatency),
                average_last_60_seconds_ms: ratio(lastMinute.totalMilliseconds, lastMinute.completed)
            },
            traffic: {
                body_bytes_received: metrics.bodyBytesReceived,
                body_bytes_sent: metrics.bodyBytesSent
            }
        };
    }

    buildOperationMetrics(metrics) {
        const describeGroups = (groups) => Array.from(groups, ([name, group]) => ({
            name: name,
            requests: group.requests,
            errors: group.errors,
            processing_time: this.summarizeLatency(group.latency)
        })).sort((a, b) => b.requests - a.requests);

        return {
            by_operation: describeGroups(metrics.operations),
            by_collection: describeGroups(metrics.collections),
            by_method: Object.fromEntries(metrics.methods),
            by_status_code: Object.fromEntries(metrics.statusCodes)
        };
    }

    // Strictly read-only: never creates directories or data files
    async scanStorageMetrics() {
        const scanStartedAt = this.getMonotonicMilliseconds();
        const basePath = this.getSecureSydbBaseDirectoryPath();
        const storage = {
            database_count: 0,
            collection_count: 0,
            instance_count: 0,
            data_size_bytes: 0,
            databases: []
        };

        const databaseNames = (await this.listAllSecureDatabases()).sort();
        for (const databaseName of databaseNames) {
            const database = {
                name: databaseName,
                collection_count: 0,
                instance_count: 0,
                data_size_bytes: 0,
                collections: []
            };

            const collectionNames = (await this.listSecureCollectionsInDatabase(databaseName)).sort();
            for (const collectionName of collectionNames) {
                const collection = { name: collectionName, instance_count: 0, data_size_bytes: 0 };
                const dataFilePath = path.join(
                    basePath, databaseName, collectionName, `data${JS_SyDB.DATA_FILE_EXTENSION}`
                );

                try {
                    collection.data_size_bytes = (await fs.promises.stat(dataFilePath)).size;
                    const fd = fs.openSync(dataFilePath, 'r');
                    try {
                        const header = this.readSecureFileHeaderInformation({ fd: fd });
                        if (header) collection.instance_count = header.recordCount;
                    } finally {
                        fs.closeSync(fd);
                    }
                } catch (error) {
                    // Missing or unreadable data file: report it as empty
                }

                database.collections.push(collection);
                database.collection_count++;
                database.instance_count += collection.instance_count;
                database.data_size_bytes += collection.data_size_bytes;
            }

            storage.databases.push(database);
            storage.database_count++;
            storage.collection_count += database.collection_count;
            storage.instance_count += database.instance_count;
            storage.data_size_bytes += database.data_size_bytes;
        }

        storage.scanned_at = new Date().toISOString();
        storage.scan_duration_ms = this.roundMetricValue(this.getMonotonicMilliseconds() - scanStartedAt);
        return storage;
    }

    async buildStorageMetrics(metrics) {
        if (metrics.storageCache &&
            this.getMonotonicMilliseconds() - metrics.storageCacheTakenAt < JS_SyDB.METRICS_STORAGE_CACHE_MILLISECONDS) {
            return metrics.storageCache;
        }

        // Concurrent callers share the same scan
        if (!metrics.storageScanPromise) {
            metrics.storageScanPromise = this.scanStorageMetrics()
                .then((storage) => {
                    metrics.storageCache = storage;
                    metrics.storageCacheTakenAt = this.getMonotonicMilliseconds();
                    return storage;
                })
                .finally(() => {
                    metrics.storageScanPromise = null;
                });
        }

        return metrics.storageScanPromise;
    }

    async buildFullMetrics(metrics) {
        const storage = await this.buildStorageMetrics(metrics);
        return {
            timestamp: new Date().toISOString(),
            instance: this.buildInstanceMetrics(metrics),
            resources: this.buildResourceMetrics(metrics),
            requests: this.buildRequestMetrics(metrics),
            performance: this.buildPerformanceMetrics(metrics),
            operations: this.buildOperationMetrics(metrics),
            recent_errors: metrics.recentErrors,
            storage: storage
        };
    }

    async httpRouteMetricsRequest(context) {
        if (context.request.method !== 'GET') {
            context.response.statusCode = 405;
            context.response.statusMessage = 'Method Not Allowed';
            context.response.headers['Allow'] = 'GET';
            context.response.body = this.createErrorResponse('Method not allowed');
            return;
        }

        const metrics = this.serverMetrics;
        if (!metrics) {
            context.response.statusCode = 503;
            context.response.statusMessage = 'Service Unavailable';
            context.response.body = this.createErrorResponse('Metrics are not available');
            return;
        }

        const section = context.request.path.split('?')[0]
            .substring(JS_SyDB.METRICS_API_PATH.length)
            .replace(/\/+$/, '');

        const sections = {
            '': ['metrics', () => this.buildFullMetrics(metrics)],
            '/instance': ['instance', () => ({
                ...this.buildInstanceMetrics(metrics),
                resources: this.buildResourceMetrics(metrics)
            })],
            '/requests': ['requests', () => ({
                ...this.buildRequestMetrics(metrics),
                recent_errors: metrics.recentErrors
            })],
            '/performance': ['performance', () => this.buildPerformanceMetrics(metrics)],
            '/operations': ['operations', () => this.buildOperationMetrics(metrics)],
            '/storage': ['storage', () => this.buildStorageMetrics(metrics)]
        };

        if (!Object.prototype.hasOwnProperty.call(sections, section)) {
            context.response.statusCode = 404;
            context.response.statusMessage = 'Not Found';
            context.response.body = this.createErrorResponse('Endpoint not found');
            return;
        }

        const [responseKey, buildSection] = sections[section];
        context.response.body = this.createSuccessResponseWithData(responseKey, JSON.stringify(await buildSection()));
    }

    // ==================== TERMINAL MONITOR (--monit) ====================
    // Pure HTTP client of /api/metrics: it never reads the database files itself

    parseMonitorArguments(commandArgs) {
        const options = {
            host: JS_SyDB.MONITOR_DEFAULT_HOST,
            port: JS_SyDB.HTTP_SERVER_PORT,
            intervalMilliseconds: JS_SyDB.MONITOR_DEFAULT_INTERVAL_MILLISECONDS
        };

        for (let i = 1; i < commandArgs.length; i++) {
            let name = commandArgs[i];
            let value;

            if (name === '--verbose') continue;

            if (name === '--host' || name === '--port' || name === '--interval') {
                value = commandArgs[++i];
                if (value === undefined || value.startsWith('--')) {
                    return { error: `Missing value for ${name}` };
                }
            } else if (/^\d+$/.test(name)) {
                value = name;
                name = '--port';
            } else {
                return { error: `Unknown monitor option '${name}'` };
            }

            if (name === '--host') {
                options.host = value.replace(/^\[|\]$/g, '');
            } else if (name === '--port') {
                const port = Number(value);
                if (!/^\d+$/.test(value) || port <= 0 || port > 65535) {
                    return { error: `Invalid port number ${value}` };
                }
                options.port = port;
            } else {
                const interval = Number(value);
                if (!/^\d+$/.test(value) ||
                    interval < JS_SyDB.MONITOR_MINIMUM_INTERVAL_MILLISECONDS ||
                    interval > JS_SyDB.MONITOR_MAXIMUM_INTERVAL_MILLISECONDS) {
                    return {
                        error: `Invalid interval ${value} (use ${JS_SyDB.MONITOR_MINIMUM_INTERVAL_MILLISECONDS}` +
                               `-${JS_SyDB.MONITOR_MAXIMUM_INTERVAL_MILLISECONDS} milliseconds)`
                    };
                }
                options.intervalMilliseconds = interval;
            }
        }

        return options;
    }

    fetchServerMetrics(host, port) {
        return new Promise((resolve, reject) => {
            const request = http.get({
                host: host,
                port: port,
                path: JS_SyDB.METRICS_API_PATH,
                agent: false,
                headers: { 'Accept': 'application/json' }
            }, (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('error', reject);
                response.on('end', () => {
                    if (response.statusCode === 404) {
                        reject(new Error('Server has no /api/metrics endpoint (restart it with this version)'));
                        return;
                    }
                    try {
                        const payload = JSON.parse(Buffer.concat(chunks).toString());
                        if (payload.success && payload.metrics) {
                            resolve(payload.metrics);
                        } else {
                            reject(new Error(payload.error || `Unexpected response (HTTP ${response.statusCode})`));
                        }
                    } catch (error) {
                        reject(new Error(`Invalid response (HTTP ${response.statusCode})`));
                    }
                });
            });

            const timeout = setTimeout(() => {
                request.destroy(new Error('Request timed out'));
            }, JS_SyDB.MONITOR_REQUEST_TIMEOUT_MILLISECONDS);

            request.on('error', reject);
            request.on('close', () => clearTimeout(timeout));
        });
    }

    sanitizeMonitorText(value) {
        // Prevents data coming from the server from injecting terminal escape sequences
        return String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    }

    formatMonitorNumber(value) {
        return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
    }

    formatMonitorBytes(bytes) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = Number(bytes || 0);
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex++;
        }
        return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
    }

    formatMonitorMilliseconds(milliseconds) {
        const value = Number(milliseconds || 0);
        if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
        return `${value.toFixed(value >= 100 ? 0 : 2)}ms`;
    }

    formatMonitorDuration(totalSeconds) {
        const seconds = Math.floor(totalSeconds);
        const days = Math.floor(seconds / 86400);
        const clock = [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60]
            .map((part) => String(part).padStart(2, '0'))
            .join(':');
        return days > 0 ? `${days}d ${clock}` : clock;
    }

    formatMonitorCell(value, width, alignLeft = false) {
        let text = this.sanitizeMonitorText(value);
        if (text.length > width) text = `${text.substring(0, width - 1)}~`;
        return alignLeft ? text.padEnd(width) : text.padStart(width);
    }

    buildMonitorSparkline(values, width) {
        const levels = '▁▂▃▄▅▆▇█';
        const visible = values.slice(-width);
        const maximum = Math.max(1, ...visible);
        return visible
            .map((value) => levels[value === 0 ? 0 : Math.max(1, Math.round(value / maximum * (levels.length - 1)))])
            .join('');
    }

    // Cuts a line to the terminal width without counting or breaking color codes
    fitMonitorLine(line, width) {
        let result = '';
        let visibleLength = 0;
        let position = 0;

        while (position < line.length) {
            if (line[position] === '\x1b') {
                const escape = /^\x1b\[[0-9;]*m/.exec(line.substring(position));
                if (escape) {
                    result += escape[0];
                    position += escape[0].length;
                    continue;
                }
            }
            if (visibleLength >= width) {
                return result.includes('\x1b') ? `${result}\x1b[0m` : result;
            }
            result += line[position];
            visibleLength++;
            position++;
        }

        return result;
    }

    buildMonitorFrame(state) {
        const paint = state.paint;
        const title = (text) => paint('1;36', text);
        const number = (value) => paint('1', this.formatMonitorNumber(value));
        const cell = (value, width, alignLeft) => this.formatMonitorCell(value, width, alignLeft);
        const time = (value) => this.formatMonitorMilliseconds(value);

        const displayHost = state.host.includes(':') ? `[${state.host}]` : state.host;
        const status = state.online ? paint('1;32', '● ONLINE') :
            paint('1;31', state.errorMessage ? '● OFFLINE' : '● CONNECTING');

        const header = [
            `${paint('1;7', ' SyDB MONITOR ')} http://${displayHost}:${state.port}  ${status}` +
            `${state.paused ? paint('1;33', '  [PAUSED]') : ''}`,
            `Refresh ${state.intervalMilliseconds}ms` +
            (state.lastSuccessAt ? `  Updated ${state.lastSuccessAt.toLocaleTimeString()}` : '') +
            (state.online ? `  API round trip ${time(state.roundTripMilliseconds)}` : '')
        ];

        if (!state.online && state.errorMessage) {
            header.push(paint('31', this.sanitizeMonitorText(state.errorMessage)) +
                (state.paused ? '' : `  (retry in ${(state.nextDelayMilliseconds / 1000).toFixed(1)}s)`));
            if (state.snapshot) header.push(paint('33', 'Showing the last data received'));
        }

        const body = [];
        const snapshot = state.snapshot;

        if (!snapshot) {
            body.push('', 'Waiting for data. Is the server running?  node JS_SyDB.js --server [port]');
            return { header, body };
        }

        const { instance, resources, requests, performance: speed, operations, storage } = snapshot;
        const perSecond = speed.requests_per_second;
        const perMinute = speed.requests_per_minute;

        body.push('', title('INSTANCE'));
        body.push(`  ID ${this.sanitizeMonitorText(instance.id)}  PID ${instance.pid}  ` +
            `Node ${this.sanitizeMonitorText(instance.node_version)}`);
        body.push(`  Uptime ${this.formatMonitorDuration(instance.uptime_seconds)}  ` +
            `Data dir ${this.sanitizeMonitorText(instance.base_directory)}`);
        body.push(`  CPU ${resources.cpu_percent.toFixed(1)}%  ` +
            (resources.event_loop_utilization_percent === null ? '' :
                `Event loop ${resources.event_loop_utilization_percent.toFixed(1)}%  `) +
            `RSS ${this.formatMonitorBytes(resources.memory.rss_bytes)}  ` +
            `Heap ${this.formatMonitorBytes(resources.memory.heap_used_bytes)}` +
            `/${this.formatMonitorBytes(resources.memory.heap_total_bytes)}`);

        body.push('', title('REQUESTS'));
        body.push(`  In progress ${paint('1;33', this.formatMonitorNumber(requests.in_progress))}  ` +
            `(receiving ${requests.receiving}, processing ${requests.processing}, responding ${requests.responding})`);
        body.push(`  Peak in progress ${number(requests.peak_in_progress)}  ` +
            `Peak processing ${number(requests.peak_processing)}`);
        body.push(`  Received ${number(requests.total_received)}  Completed ${number(requests.total_completed)}  ` +
            `OK ${paint('32', this.formatMonitorNumber(requests.total_successful))}  ` +
            `Failed ${paint(requests.total_failed ? '31' : '0', this.formatMonitorNumber(requests.total_failed))}`);
        body.push(`  Aborted ${number(requests.total_aborted)}  Rate limited ${number(requests.total_rate_limited)}  ` +
            `Error rate ${requests.error_rate_percent.toFixed(2)}%`);

        body.push('', title('THROUGHPUT'));
        body.push(`  Req/s    now ${number(perSecond.current)}  avg 10s ${number(perSecond.average_last_10_seconds)}  ` +
            `avg 60s ${number(perSecond.average_last_60_seconds)}  ` +
            `lifetime ${number(perSecond.average_since_start)}  peak ${number(perSecond.peak)}`);
        body.push(`  Req/min  last 60s ${number(perMinute.last_minute)}  ` +
            `avg 5m ${number(perMinute.average_last_5_minutes)}  ` +
            `avg 15m ${number(perMinute.average_last_15_minutes)}  ` +
            `lifetime ${number(perMinute.average_since_start)}`);
        body.push(`  Last 60s ${paint('32', this.buildMonitorSparkline(speed.history_last_60_seconds, 60))}`);
        body.push(`  Traffic  in ${this.formatMonitorBytes(speed.traffic.body_bytes_received)}  ` +
            `out ${this.formatMonitorBytes(speed.traffic.body_bytes_sent)}  (bodies only)`);

        body.push('', title('TIME PER REQUEST'));
        body.push(paint('2', `  ${cell('', 11, true)}${['avg', 'avg 60s', 'median', 'p95', 'p99', 'max', 'last']
            .map((label) => cell(label, 9)).join('')}`));
        for (const [label, latency] of [['Processing', speed.processing_time], ['Total', speed.total_time]]) {
            body.push(`  ${cell(label, 11, true)}` + [
                latency.average_ms, latency.average_last_60_seconds_ms, latency.median_ms,
                latency.p95_ms, latency.p99_ms, latency.max_ms, latency.last_ms
            ].map((value) => cell(time(value), 9)).join(''));
        }

        if (requests.active.length > 0) {
            body.push('', title('ACTIVE NOW'));
            for (const active of requests.active.slice(0, 5)) {
                body.push(`  ${cell(active.method, 7, true)}${cell(active.phase, 11, true)}` +
                    `${cell(time(active.elapsed_ms), 9)}  ${this.sanitizeMonitorText(active.path)}`);
            }
        }

        const groupTable = (heading, nameLabel, groups) => {
            body.push('', title(heading));
            body.push(paint('2', `  ${cell(nameLabel, 28, true)}${cell('requests', 10)}${cell('errors', 8)}` +
                `${cell('avg', 10)}${cell('max', 10)}`));
            if (groups.length === 0) body.push('  (no requests yet)');
            for (const group of groups) {
                body.push(`  ${cell(group.name, 28, true)}` +
                    `${cell(this.formatMonitorNumber(group.requests), 10)}` +
                    `${cell(this.formatMonitorNumber(group.errors), 8)}` +
                    `${cell(time(group.processing_time.average_ms), 10)}` +
                    `${cell(time(group.processing_time.max_ms), 10)}`);
            }
        };

        groupTable('OPERATIONS', 'operation', operations.by_operation);
        groupTable('BUSIEST COLLECTIONS', 'database/collection', operations.by_collection.slice(0, 5));

        body.push('', title('STORAGE'));
        body.push(`  Databases ${number(storage.database_count)}  Collections ${number(storage.collection_count)}  ` +
            `Instances ${number(storage.instance_count)}  Size ${this.formatMonitorBytes(storage.data_size_bytes)}`);
        if (storage.databases.length > 0) {
            body.push(paint('2', `  ${cell('database/collection', 38, true)}${cell('instances', 12)}${cell('size', 12)}`));
        }
        for (const database of storage.databases) {
            const row = (name, entry) => `  ${cell(name, 38, true)}` +
                `${cell(this.formatMonitorNumber(entry.instance_count), 12)}` +
                `${cell(this.formatMonitorBytes(entry.data_size_bytes), 12)}`;
            body.push(row(database.name, database));
            for (const collection of database.collections) {
                body.push(row(`  └ ${collection.name}`, collection));
            }
        }

        if (snapshot.recent_errors.length > 0) {
            body.push('', title('RECENT ERRORS'));
            for (const entry of snapshot.recent_errors.slice(0, 5)) {
                body.push(`  ${new Date(entry.timestamp).toLocaleTimeString()}  ${entry.status_code}  ` +
                    `${this.sanitizeMonitorText(entry.method)} ${this.sanitizeMonitorText(entry.path)}  ` +
                    paint('31', this.sanitizeMonitorText(entry.error)));
            }
        }

        return { header, body };
    }

    // Redraws only the lines that changed, which avoids flickering
    renderMonitorScreen(state) {
        const width = process.stdout.columns || 80;
        const height = process.stdout.rows || 24;
        const { header, body } = this.buildMonitorFrame(state);

        const bodyHeight = Math.max(0, height - header.length - 1);
        const maximumScroll = Math.max(0, body.length - bodyHeight);
        state.scrollOffset = Math.min(Math.max(0, state.scrollOffset), maximumScroll);

        let footer = 'q quit  p pause  r refresh  +/- slower/faster';
        if (maximumScroll > 0) {
            footer += `  ↑/↓ scroll [${state.scrollOffset}/${maximumScroll}]`;
        }

        const lines = [
            ...header,
            ...body.slice(state.scrollOffset, state.scrollOffset + bodyHeight),
            state.paint('2', footer)
        ].slice(0, height).map((line) => this.fitMonitorLine(line, width - 1));

        let output = '';
        if (state.forceRedraw) {
            output += '\x1b[2J';
            state.previousLines = [];
            state.forceRedraw = false;
        }

        const lineCount = Math.min(height, Math.max(lines.length, state.previousLines.length));
        for (let i = 0; i < lineCount; i++) {
            const line = lines[i] || '';
            if (line !== state.previousLines[i]) {
                output += `\x1b[${i + 1};1H${line}\x1b[K`;
            }
        }

        state.previousLines = lines;
        if (output) process.stdout.write(output);
    }

    startMonitor(options) {
        const interactive = Boolean(process.stdout.isTTY);
        const keyboard = interactive && Boolean(process.stdin.isTTY);
        const useColors = interactive && !process.env.NO_COLOR;

        const state = {
            host: options.host,
            port: options.port,
            intervalMilliseconds: options.intervalMilliseconds,
            snapshot: null,
            online: false,
            errorMessage: '',
            lastSuccessAt: null,
            roundTripMilliseconds: 0,
            nextDelayMilliseconds: options.intervalMilliseconds,
            consecutiveFailures: 0,
            paused: false,
            scrollOffset: 0,
            previousLines: [],
            forceRedraw: true,
            paint: (code, text) => useColors ? `\x1b[${code}m${text}\x1b[0m` : String(text)
        };

        return new Promise((resolve) => {
            let timer = null;
            let polling = false;
            let stopped = false;

            const render = () => {
                if (stopped) return;
                if (interactive) {
                    this.renderMonitorScreen(state);
                } else {
                    const { header, body } = this.buildMonitorFrame(state);
                    process.stdout.write(`${[...header, ...body].join('\n')}\n\n`);
                }
            };

            const poll = async () => {
                if (stopped || polling) return;
                polling = true;
                clearTimeout(timer);

                const requestStartedAt = this.getMonotonicMilliseconds();
                try {
                    state.snapshot = await this.fetchServerMetrics(state.host, state.port);
                    state.online = true;
                    state.errorMessage = '';
                    state.lastSuccessAt = new Date();
                    state.consecutiveFailures = 0;
                } catch (error) {
                    state.online = false;
                    state.errorMessage = error.message || error.code || 'Connection failed';
                    state.consecutiveFailures++;
                }
                state.roundTripMilliseconds = this.getMonotonicMilliseconds() - requestStartedAt;
                polling = false;
                if (stopped) return;

                const interval = state.intervalMilliseconds;
                if (state.online) {
                    // A slow server is polled less often, so the monitor never piles up on it
                    state.nextDelayMilliseconds = Math.max(
                        interval - state.roundTripMilliseconds,
                        state.roundTripMilliseconds
                    );
                } else {
                    // Exponential backoff while the server is unreachable
                    state.nextDelayMilliseconds = Math.max(interval, Math.min(
                        JS_SyDB.MONITOR_MAXIMUM_BACKOFF_MILLISECONDS,
                        interval * Math.pow(2, state.consecutiveFailures - 1)
                    ));
                }

                render();

                // The next poll is scheduled only after this one ends: requests never overlap
                clearTimeout(timer);
                if (!state.paused) {
                    timer = setTimeout(poll, state.nextDelayMilliseconds);
                }
            };

            const onKey = (data) => {
                const key = data.toString();
                const page = Math.max(1, (process.stdout.rows || 24) - 4);

                if (key === 'q' || key === 'Q' || key === '\u0003' || key === '\u001b') {
                    stop();
                    return;
                }

                if (key === 'p' || key === 'P') {
                    state.paused = !state.paused;
                    clearTimeout(timer);
                    if (!state.paused) poll();
                } else if (key === 'r' || key === 'R') {
                    state.forceRedraw = true;
                    poll();
                } else if (key === '+' || key === '=') {
                    state.intervalMilliseconds = Math.min(
                        JS_SyDB.MONITOR_MAXIMUM_INTERVAL_MILLISECONDS, state.intervalMilliseconds * 2
                    );
                } else if (key === '-') {
                    state.intervalMilliseconds = Math.max(
                        JS_SyDB.MONITOR_MINIMUM_INTERVAL_MILLISECONDS, Math.round(state.intervalMilliseconds / 2)
                    );
                    if (!state.paused) poll();
                } else if (key === '\u001b[A' || key === 'k') {
                    state.scrollOffset--;
                } else if (key === '\u001b[B' || key === 'j') {
                    state.scrollOffset++;
                } else if (key === '\u001b[5~') {
                    state.scrollOffset -= page;
                } else if (key === '\u001b[6~') {
                    state.scrollOffset += page;
                }

                render();
            };

            const onResize = () => {
                state.forceRedraw = true;
                render();
            };

            const restoreTerminal = () => {
                if (keyboard) process.stdin.setRawMode(false);
                if (interactive) process.stdout.write('\x1b[?25h\x1b[?1049l');
            };

            const stop = () => {
                if (stopped) return;
                stopped = true;
                clearTimeout(timer);

                process.removeListener('SIGINT', stop);
                process.removeListener('SIGTERM', stop);
                process.removeListener('exit', restoreTerminal);
                process.stdout.removeListener('resize', onResize);
                process.stdout.removeListener('error', stop);
                if (keyboard) {
                    process.stdin.removeListener('data', onKey);
                    process.stdin.pause();
                }

                restoreTerminal();
                resolve(0);
            };

            process.on('SIGINT', stop);
            process.on('SIGTERM', stop);
            process.on('exit', restoreTerminal);
            process.stdout.on('error', stop);

            if (interactive) {
                // Alternate screen with hidden cursor: the shell history stays untouched
                process.stdout.write('\x1b[?1049h\x1b[?25l');
                process.stdout.on('resize', onResize);
                render();
            }

            if (keyboard) {
                process.stdin.setRawMode(true);
                process.stdin.resume();
                process.stdin.on('data', onKey);
            }

            poll();
        });
    }

    // ==================== HTTP REQUEST ROUTING ====================
    // MUST MATCH C VERSION EXACTLY

    async httpRouteRequest(context) {
        const path = context.request.path;
        const method = context.request.method;

        if (this.verboseMode) {
            console.log(`Routing request: ${method} ${path}`);
        }

        if (this.isMetricsApiPath(path)) {
            await this.httpRouteMetricsRequest(context);
            return;
        }

        const pathComponents = this.parseApiPathOptimized(path);

        if (pathComponents && pathComponents.databaseName) {
            if (method === 'GET') {
                if (!pathComponents.collectionName && !pathComponents.instanceId) {
                    const responseJson = await this.httpApiListCollections(pathComponents.databaseName);
                    context.response.body = responseJson;
                    return;
                } else if (pathComponents.collectionName && path.includes('/schema')) {
                    const responseJson = await this.httpApiGetCollectionSchema(
                        pathComponents.databaseName,
                        pathComponents.collectionName
                    );
                    context.response.body = responseJson;
                    return;
                } else if (pathComponents.collectionName && !pathComponents.instanceId) {
                    const url = new URL(`http://localhost${path}`);
                    const query = url.searchParams.get('query');
                    const responseJson = await this.httpApiListInstances(
                        pathComponents.databaseName,
                        pathComponents.collectionName,
                        query
                    );
                    context.response.body = responseJson;
                    return;
                }
            } else if (method === 'POST') {
                if (pathComponents.collectionName && !pathComponents.instanceId) {
                    if (context.request.body) {
                        const responseJson = await this.httpApiInsertInstance(
                            pathComponents.databaseName,
                            pathComponents.collectionName,
                            context.request.body
                        );
                        context.response.body = responseJson;
                    } else {
                        context.response.body = '{"success":false,"error":"Request body is required"}';
                    }
                    return;
                } else if (!pathComponents.collectionName && !pathComponents.instanceId) {
                    if (context.request.body) {
                        const responseJson = await this.httpApiCreateCollection(
                            pathComponents.databaseName,
                            context.request.body
                        );
                        context.response.body = responseJson;
                    } else {
                        context.response.body = '{"success":false,"error":"Request body is required"}';
                    }
                    return;
                }
            } else if (method === 'PUT') {
                if (pathComponents.collectionName && pathComponents.instanceId) {
                    if (context.request.body) {
                        const responseJson = await this.httpApiUpdateInstance(
                            pathComponents.databaseName,
                            pathComponents.collectionName,
                            pathComponents.instanceId,
                            context.request.body
                        );
                        context.response.body = responseJson;
                    } else {
                        context.response.body = '{"success":false,"error":"Request body is required"}';
                    }
                    return;
                }
            } else if (method === 'DELETE') {
                if (pathComponents.collectionName && pathComponents.instanceId) {
                    const responseJson = await this.httpApiDeleteInstance(
                        pathComponents.databaseName,
                        pathComponents.collectionName,
                        pathComponents.instanceId
                    );
                    context.response.body = responseJson;
                    return;
                } else if (pathComponents.collectionName && !pathComponents.instanceId) {
                    const responseJson = await this.httpApiDeleteCollection(
                        pathComponents.databaseName,
                        pathComponents.collectionName
                    );
                    context.response.body = responseJson;
                    return;
                } else if (!pathComponents.collectionName && !pathComponents.instanceId) {
                    const responseJson = await this.httpApiDeleteDatabase(pathComponents.databaseName);
                    context.response.body = responseJson;
                    return;
                }
            }
        }

        if (method === 'GET') {
            if (path === '/api/databases') {
                const responseJson = await this.httpApiListDatabases();
                context.response.body = responseJson;
            } else {
                context.response.statusCode = 404;
                context.response.body = '{"success":false,"error":"Endpoint not found"}';
            }
        } else if (method === 'POST') {
            if (path === '/api/databases') {
                if (context.request.body) {
                    try {
                        const request = JSON.parse(context.request.body);
                        const databaseName = request.name;
                        if (databaseName) {
                            const responseJson = await this.httpApiCreateDatabase(databaseName);
                            context.response.body = responseJson;
                        } else {
                            context.response.body = '{"success":false,"error":"Database name is required"}';
                        }
                    } catch (error) {
                        context.response.body = '{"success":false,"error":"Invalid request format"}';
                    }
                } else {
                    context.response.body = '{"success":false,"error":"Request body is required"}';
                }
            } else if (path === '/api/execute') {
                if (context.request.body) {
                    const responseJson = await this.httpApiExecuteCommand(context.request.body);
                    context.response.body = responseJson;
                } else {
                    context.response.body = '{"success":false,"error":"Request body is required"}';
                }
            } else {
                context.response.statusCode = 404;
                context.response.body = '{"success":false,"error":"Endpoint not found"}';
            }
        } else if (method === 'PUT') {
            context.response.statusCode = 404;
            context.response.body = '{"success":false,"error":"Endpoint not found"}';
        } else if (method === 'DELETE') {
            context.response.statusCode = 404;
            context.response.body = '{"success":false,"error":"Endpoint not found"}';
        } else {
            context.response.statusCode = 405;
            context.response.headers = context.response.headers || {};
            context.response.headers['Allow'] = 'GET, POST, PUT, DELETE';
            context.response.body = '{"success":false,"error":"Method not allowed"}';
        }
    }

    // ==================== HTTP SERVER IMPLEMENTATION ====================
    // MUST MATCH C VERSION EXACTLY

    async httpClientHandler(clientContext) {
        if (!clientContext) return;

        if (this.verboseMode) {
            console.log(`Client handler started for ${clientContext.clientAddress}`);
            console.log(`Request: ${clientContext.request.method} ${clientContext.request.path}`);
        }

        clientContext.response = {
            statusCode: 200,
            statusMessage: 'OK',
            headers: {
                'Server': 'SYDB-HTTP-Server/1.0',
                'Connection': 'close',
                'Content-Type': 'application/json'
            },
            body: ''
        };

        await this.httpRouteRequest(clientContext);

        if (this.verboseMode) {
            console.log(`Request processed, status code: ${clientContext.response.statusCode}`);
        }
    }

    cleanupClientConnection(context) {
        if (!context) return;
        if (context.socket && !context.socket.destroyed) {
            context.socket.destroy();
        }
    }

    async httpServerStart(port, verboseMode = false) {
        if (this.serverInstance) {
            console.error('HTTP server is already running');
            return -1;
        }

        this.verboseMode = verboseMode;

        if (this.verboseMode) {
            console.log(`Initializing http server on port ${port}, Verbose mode=${verboseMode}`);
        }

        this.threadPool = this.createThreadPool(
            JS_SyDB.THREAD_POOL_WORKER_COUNT,
            JS_SyDB.THREAD_POOL_QUEUE_CAPACITY
        );

        if (!this.threadPool) {
            return -1;
        }

        if (this.verboseMode) {
            console.log('Thread pool created successfully');
        }

        this.fileConnectionPool = this.createFileConnectionPool(JS_SyDB.FILE_CONNECTION_POOL_SIZE);

        if (this.verboseMode) {
            console.log('File connection pool created');
        }

        this.rateLimiter = this.createRateLimiter();

        if (this.verboseMode) {
            console.log('Rate limiter created');
        }

        this.httpServer = http.createServer(async (req, res) => {
            const requestMetricsTracker = this.beginRequestMetrics(req, res);

            try {
                const clientIp = req.socket.remoteAddress;
                if (!(await this.checkRateLimit(this.rateLimiter, clientIp))) {
                    res.writeHead(429, { 'Content-Type': 'application/json' });
                    res.end('{"success":false,"error":"Rate limit exceeded"}');
                    return;
                }

                const chunks = [];
                req.on('data', (chunk) => chunks.push(chunk));

                await new Promise((resolve) => {
                    req.on('end', resolve);
                });

                const body = Buffer.concat(chunks).toString();

                const clientContext = {
                    socket: req.socket,
                    clientAddress: clientIp,
                    clientPort: req.socket.remotePort,
                    request: {
                        method: req.method || 'GET',
                        path: req.url || '/',
                        headers: req.headers,
                        url: req.url,
                        body: body
                    },
                    response: null
                };

                this.startRequestProcessingMetrics(requestMetricsTracker, body);
                try {
                    await this.httpClientHandler(clientContext);
                } finally {
                    this.endRequestProcessingMetrics(requestMetricsTracker, clientContext);
                }

                if (clientContext.response) {
                    res.writeHead(
                        clientContext.response.statusCode,
                        clientContext.response.statusMessage,
                        clientContext.response.headers
                    );
                    res.end(clientContext.response.body);
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end('{"success":false,"error":"Internal server error"}');
                }
            } catch (error) {
                console.error('Error handling request:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end('{"success":false,"error":"Internal server error"}');
            }
        });

        process.on('SIGINT', () => this.httpServerStop());
        process.on('SIGTERM', () => this.httpServerStop());

        await this.initializeBaseDirectory();

        return new Promise((resolve) => {
            this.httpServer.listen(port, () => {
                this.serverInstance = {
                    httpServer: this.httpServer,
                    port: port,
                    runningFlag: true
                };

                this.runningFlag = true;
                this.serverMetrics = this.createServerMetrics(port);

                if (this.verboseMode) {
                    console.log('Server startup completed successfully');
                }

                console.log(`SYDB HTTP Server started on port ${port}`);
                console.log('Server is running with performance enhancements:');
                console.log(`  - Thread pool: ${JS_SyDB.THREAD_POOL_WORKER_COUNT} workers`);
                console.log(`  - File connection pool: ${JS_SyDB.FILE_CONNECTION_POOL_SIZE} connections`);
                console.log(`  - Rate limiting: ${JS_SyDB.RATE_LIMIT_MAX_REQUESTS} requests per ${JS_SyDB.RATE_LIMIT_WINDOW_SECONDS} seconds`);

                if (verboseMode) {
                    console.log('  - Verbose logging: ENABLED (extreme detail)');
                }

                console.log('Press Ctrl+C to stop the server');
                resolve(0);
            });

            this.httpServer.on('error', (error) => {
                console.error(`Failed to start HTTP server: ${error.message}`);
                resolve(-1);
            });
        });
    }

    httpServerStop() {
        if (!this.serverInstance) {
            return;
        }

        if (this.verboseMode) {
            console.log('Server shutdown initiated');
        }

        this.runningFlag = false;
        this.serverInstance.runningFlag = false;

        if (this.httpServer) {
            this.httpServer.close();
            this.httpServer = null;
        }

        if (this.threadPool) {
            this.destroyThreadPool(this.threadPool);
        }

        if (this.fileConnectionPool) {
            this.destroyFileConnectionPool(this.fileConnectionPool);
        }

        if (this.rateLimiter) {
            this.destroyRateLimiter(this.rateLimiter);
        }

        if (this.cache) {
            this.destroySecureLruCache(this.cache);
        }

        this.serverInstance = null;

        if (this.verboseMode) {
            console.log('Server shutdown completed successfully');
        }

        console.log('SYDB HTTP Server stopped');
    }

    // ==================== INITIALIZATION ====================

    async initializeBaseDirectory() {
        const basePath = this.getSecureSydbBaseDirectoryPath();
        await this.createSecureDirectoryRecursively(basePath);
    }

    // ==================== COMMAND LINE INTERFACE ====================
    // MUST MATCH C VERSION EXACTLY

    printSecureUsageInformation() {
        console.log("Usage:");
        console.log("  node JS_SyDB.js create <database_name>");
        console.log("  node JS_SyDB.js create <database_name> <collection_name> --schema --<field>-<type>[-req][-idx] ...");
        console.log("  node JS_SyDB.js create <database_name> <collection_name> --insert-one --<field>-\"<value>\" ...");
        console.log("  node JS_SyDB.js update <database_name> <collection_name> --where \"<query>\" --set --<field>-\"<value>\" ...");
        console.log("  node JS_SyDB.js delete <database_name> <collection_name> --where \"<query>\"");
        console.log("  node JS_SyDB.js find <database_name> <collection_name> --where \"<query>\"");
        console.log("  node JS_SyDB.js schema <database_name> <collection_name>");
        console.log("  node JS_SyDB.js list");
        console.log("  node JS_SyDB.js list <database_name>");
        console.log("  node JS_SyDB.js list <database_name> <collection_name>");
        console.log("  node JS_SyDB.js --server [port]          # Start HTTP server");
        console.log("  node JS_SyDB.js --server --verbose       # Start HTTP server with extreme logging");
        console.log("  node JS_SyDB.js --routes                 # Show all HTTP API routes and schemas");
        console.log("  node JS_SyDB.js --monit [port] [--host <host>] [--port <port>] [--interval <ms>]  # Live server monitor");
        console.log("\nField types: string, int, float, bool, array, object");
        console.log("Add -req for required fields");
        console.log("Add -idx for indexed fields (improves query performance)");
        console.log("Query format: field:value,field2:value2 (multiple conditions supported)");
        console.log("Server mode: Starts HTTP server on specified port (default: 8080)");
        console.log("Verbose mode: Extreme logging for server operations and requests");
    }

    async runCommand(args) {
        const commandArgs = args.slice(2);

        if (commandArgs.length < 1) {
            this.printSecureUsageInformation();
            return 1;
        }

        let verboseMode = false;
        for (let i = 0; i < commandArgs.length; i++) {
            if (commandArgs[i] === '--verbose') {
                verboseMode = true;
                console.log("VERBOSE MODE: Enabled - Extreme logging activated");
            }
        }

        if (commandArgs[0] === '--routes') {
            this.displayHttpRoutes();
            return 0;
        }

        if (commandArgs[0] === '--server') {
            let port = JS_SyDB.HTTP_SERVER_PORT;

            if (commandArgs.length > 1) {
                if (commandArgs[1] !== '--verbose') {
                    port = parseInt(commandArgs[1], 10);
                    if (isNaN(port) || port <= 0 || port > 65535) {
                        console.error(`Error: Invalid port number ${commandArgs[1]}`);
                        return 1;
                    }
                }
            }

            console.log(`Starting SYDB HTTP Server on port ${port}...`);

            if (verboseMode) {
                console.log("VERBOSE: Server starting with verbose logging enabled");
            }

            console.log("Press Ctrl+C to stop the server");

            const result = await this.httpServerStart(port, verboseMode);

            if (result === 0) {
                return new Promise(() => {});
            }

            return result;
        }

        if (commandArgs[0] === '--monit') {
            const monitorOptions = this.parseMonitorArguments(commandArgs);
            if (monitorOptions.error) {
                console.error(`Error: ${monitorOptions.error}`);
                return 1;
            }
            return this.startMonitor(monitorOptions);
        }

        await this.initializeBaseDirectory();

        if (commandArgs[0] === 'create') {
            if (commandArgs.length < 2) {
                console.error("Error: Missing database name");
                this.printSecureUsageInformation();
                return 1;
            }

            if (!this.validateDatabaseName(commandArgs[1])) {
                console.error(`Error: Invalid database name '${commandArgs[1]}'`);
                return 1;
            }

            if (commandArgs.length === 2) {
                return await this.createSecureDatabase(commandArgs[1]);
            } else if (commandArgs.length >= 4) {
                if (!this.validateCollectionName(commandArgs[2])) {
                    console.error(`Error: Invalid collection name '${commandArgs[2]}'`);
                    return 1;
                }

                let schemaFlagIndex = -1;
                let insertFlagIndex = -1;

                for (let i = 3; i < commandArgs.length; i++) {
                    if (commandArgs[i] === '--schema') {
                        schemaFlagIndex = i;
                        break;
                    } else if (commandArgs[i] === '--insert-one') {
                        insertFlagIndex = i;
                        break;
                    }
                }

                if (schemaFlagIndex !== -1) {
                    const fields = [];
                    let fieldCount = 0;

                    for (let i = schemaFlagIndex + 1; i < commandArgs.length; i++) {
                        const fieldSpec = commandArgs[i];
                        if (!fieldSpec || !fieldSpec.startsWith('--')) continue;

                        const spec = fieldSpec.substring(2);
                        const parts = spec.split('-');
                        if (parts.length < 2) continue;

                        const fieldName = parts[0];
                        let type = parts[1];
                        let required = false;
                        let indexed = false;

                        for (let j = 2; j < parts.length; j++) {
                            if (parts[j] === 'req') required = true;
                            if (parts[j] === 'idx') indexed = true;
                        }

                        fields.push({
                            name: fieldName,
                            type: this.parseSecureFieldTypeFromString(type),
                            required: required,
                            indexed: indexed
                        });
                        fieldCount++;
                    }

                    if (fieldCount === 0) {
                        console.error("Error: No valid schema fields provided");
                        return 1;
                    }

                    return await this.createSecureCollection(commandArgs[1], commandArgs[2], fields, fieldCount);
                } else if (insertFlagIndex !== -1) {
                    const fieldNames = [];
                    const fieldValues = [];
                    let fieldCount = 0;

                    for (let i = insertFlagIndex + 1; i < commandArgs.length; i++) {
                        const fieldSpec = commandArgs[i];
                        if (!fieldSpec || !fieldSpec.startsWith('--')) continue;

                        const spec = fieldSpec.substring(2);
                        const hyphenPos = spec.indexOf('-');
                        if (hyphenPos === -1) continue;

                        const fieldName = spec.substring(0, hyphenPos);
                        let fieldValue = spec.substring(hyphenPos + 1);

                        if (fieldValue.startsWith('"') && fieldValue.endsWith('"')) {
                            fieldValue = fieldValue.substring(1, fieldValue.length - 1);
                        }

                        fieldNames.push(fieldName);
                        fieldValues.push(fieldValue);
                        fieldCount++;
                    }

                    if (fieldCount === 0) {
                        console.error("Error: No valid insert fields provided");
                        return 1;
                    }

                    const uuid = this.generateSecureUniversallyUniqueIdentifier();
                    let instanceJson = this.buildSecureInstanceJsonFromFieldsAndValues(fieldNames, fieldValues, fieldCount);

                    if (!instanceJson) {
                        console.error("Error: Failed to build instance JSON");
                        return 1;
                    }

                    try {
                        const instanceObj = JSON.parse(instanceJson);
                        instanceObj._id = uuid;
                        instanceJson = JSON.stringify(instanceObj);
                    } catch (error) {
                        if (instanceJson.startsWith('{') && instanceJson.endsWith('}')) {
                            const jsonWithoutBraces = instanceJson.substring(1, instanceJson.length - 1);
                            instanceJson = `{"_id":"${uuid}",${jsonWithoutBraces}}`;
                        } else {
                            instanceJson = `{"_id":"${uuid}","data":${JSON.stringify(instanceJson)}}`;
                        }
                    }

                    const result = await this.insertSecureInstanceIntoCollection(commandArgs[1], commandArgs[2], instanceJson);

                    if (result === 0) {
                        console.log(`Instance created with ID: ${uuid}`);
                        return 0;
                    } else {
                        console.error("Error: Failed to insert instance");
                        return 1;
                    }
                } else {
                    console.error("Error: Missing --schema or --insert-one flag");
                    this.printSecureUsageInformation();
                    return 1;
                }
            } else {
                console.error("Error: Invalid create operation");
                this.printSecureUsageInformation();
                return 1;
            }
        } else if (commandArgs[0] === 'find') {
            if (commandArgs.length < 6 || commandArgs[4] !== '--where') {
                console.error("Error: Invalid find syntax. Use: node JS_SyDB.js find <database> <collection> --where \"query\"");
                this.printSecureUsageInformation();
                return 1;
            }

            if (!this.validateDatabaseName(commandArgs[1]) || !this.validateCollectionName(commandArgs[2])) {
                console.error("Error: Invalid database or collection name");
                return 1;
            }

            const results = await this.findSecureInstancesWithQuery(commandArgs[1], commandArgs[2], commandArgs[5]);
            for (const result of results) {
                console.log(result);
            }

            return 0;
        } else if (commandArgs[0] === 'schema') {
            if (commandArgs.length < 4) {
                console.error("Error: Missing database or collection name");
                this.printSecureUsageInformation();
                return 1;
            }

            if (!this.validateDatabaseName(commandArgs[1]) || !this.validateCollectionName(commandArgs[2])) {
                console.error("Error: Invalid database or collection name");
                return 1;
            }

            const basePath = this.getSecureSydbBaseDirectoryPath();
            const schemaFilePath = path.join(basePath, commandArgs[1], commandArgs[2], 'schema.txt');

            try {
                const schemaContent = await fs.promises.readFile(schemaFilePath, 'utf8');
                console.log(`Schema for collection ${commandArgs[2]} in database ${commandArgs[1]}:`);
                console.log(schemaContent);
                return 0;
            } catch (error) {
                console.error(`Error: Cannot load schema for collection '${commandArgs[2]}'`);
                return 1;
            }
        } else if (commandArgs[0] === 'list') {
            if (commandArgs.length === 1) {
                const databases = await this.listAllSecureDatabases();
                if (databases.length === 0) {
                    console.log("No databases found");
                } else {
                    for (const db of databases) {
                        console.log(db);
                    }
                }
                return 0;
            } else if (commandArgs.length === 2) {
                if (!this.validateDatabaseName(commandArgs[1])) {
                    console.error(`Error: Invalid database name '${commandArgs[1]}'`);
                    return 1;
                }

                const collections = await this.listSecureCollectionsInDatabase(commandArgs[1]);
                if (collections.length === 0) {
                    console.log(`No collections found in database '${commandArgs[1]}'`);
                } else {
                    for (const coll of collections) {
                        console.log(coll);
                    }
                }
                return 0;
            } else if (commandArgs.length === 3) {
                if (!this.validateDatabaseName(commandArgs[1]) || !this.validateCollectionName(commandArgs[2])) {
                    console.error("Error: Invalid database or collection name");
                    return 1;
                }

                const instances = await this.listAllSecureInstancesInCollection(commandArgs[1], commandArgs[2]);
                if (instances.length === 0) {
                    console.log(`No instances found in collection '${commandArgs[2]}'`);
                } else {
                    for (const instance of instances) {
                        console.log(instance);
                    }
                }
                return 0;
            } else {
                console.error("Error: Invalid list operation");
                this.printSecureUsageInformation();
                return 1;
            }
        } else if (commandArgs[0] === 'update') {
            let wherePos = -1;
            let setPos = -1;

            for (let i = 4; i < commandArgs.length; i++) {
                if (commandArgs[i] === '--where') wherePos = i;
                else if (commandArgs[i] === '--set') setPos = i;
            }

            if (wherePos === -1 || setPos === -1) {
                console.error("Error: Missing --where or --set flag");
                return 1;
            }

            if (wherePos + 1 >= commandArgs.length) {
                console.error("Error: Missing query after --where");
                return 1;
            }

            if (setPos + 1 >= commandArgs.length) {
                console.error("Error: Missing field specifications after --set");
                return 1;
            }

            if (!this.validateDatabaseName(commandArgs[1]) || !this.validateCollectionName(commandArgs[2])) {
                console.error("Error: Invalid database or collection name");
                return 1;
            }

            const query = commandArgs[wherePos + 1];
            const results = await this.findSecureInstancesWithQuery(commandArgs[1], commandArgs[2], query);

            if (results.length === 0) {
                console.error("Error: No instances found matching the query");
                return 1;
            }

            const firstResult = results[0];
            const idStart = firstResult.indexOf('"_id":"');
            if (idStart === -1) {
                console.error("Error: Could not parse instance ID");
                return 1;
            }

            const idValueStart = idStart + 7;
            const idEnd = firstResult.indexOf('"', idValueStart);
            if (idEnd === -1) {
                console.error("Error: Could not parse instance ID");
                return 1;
            }

            const instanceId = firstResult.substring(idValueStart, idEnd);

            const fieldNames = [];
            const fieldValues = [];

            for (let i = setPos + 1; i < commandArgs.length; i++) {
                const fieldSpec = commandArgs[i];
                if (!fieldSpec || !fieldSpec.startsWith('--')) break;

                const spec = fieldSpec.substring(2);
                const hyphenPos = spec.indexOf('-');
                if (hyphenPos === -1) continue;

                const fieldName = spec.substring(0, hyphenPos);
                let fieldValue = spec.substring(hyphenPos + 1);

                if (fieldValue.startsWith('"') && fieldValue.endsWith('"')) {
                    fieldValue = fieldValue.substring(1, fieldValue.length - 1);
                }

                fieldNames.push(fieldName);
                fieldValues.push(fieldValue);
            }

            if (fieldNames.length === 0) {
                console.error("Error: No valid update fields provided");
                return 1;
            }

            let updateJson = this.buildSecureInstanceJsonFromFieldsAndValues(fieldNames, fieldValues, fieldNames.length);
            if (!updateJson) {
                console.error("Error: Failed to build update JSON");
                return 1;
            }

            const result = await this.updateSecureInstanceInCollection(commandArgs[1], commandArgs[2], instanceId, updateJson);
            if (result === 0) {
                console.log("Instance updated successfully");
                return 0;
            } else {
                console.error("Error: Failed to update instance");
                return 1;
            }
        } else if (commandArgs[0] === 'delete') {
            if (commandArgs.length < 7 || commandArgs[5] !== '--where') {
                console.error("Error: Invalid delete syntax. Use: node JS_SyDB.js delete <database> <collection> --where \"query\"");
                this.printSecureUsageInformation();
                return 1;
            }

            if (!this.validateDatabaseName(commandArgs[1]) || !this.validateCollectionName(commandArgs[2])) {
                console.error("Error: Invalid database or collection name");
                return 1;
            }

            const query = commandArgs[6];
            const results = await this.findSecureInstancesWithQuery(commandArgs[1], commandArgs[2], query);

            if (results.length === 0) {
                console.error("Error: No instances found matching the query");
                return 1;
            }

            const firstResult = results[0];
            const idStart = firstResult.indexOf('"_id":"');
            if (idStart === -1) {
                console.error("Error: Could not parse instance ID");
                return 1;
            }

            const idValueStart = idStart + 7;
            const idEnd = firstResult.indexOf('"', idValueStart);
            if (idEnd === -1) {
                console.error("Error: Could not parse instance ID");
                return 1;
            }

            const instanceId = firstResult.substring(idValueStart, idEnd);

            const result = await this.deleteSecureInstanceFromCollection(commandArgs[1], commandArgs[2], instanceId);
            if (result === 0) {
                console.log("Instance deleted successfully");
                return 0;
            } else {
                console.error("Error: Failed to delete instance");
                return 1;
            }
        } else {
            console.error(`Error: Unknown command '${commandArgs[0]}'`);
            this.printSecureUsageInformation();
            return 1;
        }
    }
}

export default JS_SyDB;

if (process.argv[1] === fileURLToPath(import.meta.url) && (process.argv.length > 2 || !path.basename(process.argv[1]).startsWith('sypm'))) {
    const sydb = new JS_SyDB();
    sydb.runCommand(process.argv).then(code => {
        if (code !== undefined && typeof code === 'number') {
            process.exit(code);
        }
    }).catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}