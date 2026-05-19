#!/usr/bin/env node

import http from 'http';
import fs from 'fs/promises';
import { existsSync, statSync, readFileSync } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import url from 'url';

// Get directory path from command line argument
const targetDir = process.argv[2];

if (!targetDir) {
    console.error('Please provide a directory path as the first argument');
    console.error('Usage: node arch.js /path/to/directory');
    process.exit(1);
}

const absolutePath = path.resolve(targetDir);

// Check if directory exists
if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) {
    console.error(`Error: ${absolutePath} is not a valid directory`);
    process.exit(1);
}

const PORT = 3000;

// Check if it's a git repository
let isGitRepo = false;
let commits = [];

try {
    execSync('git rev-parse --git-dir', { cwd: absolutePath, stdio: 'ignore' });
    isGitRepo = true;
    
    const gitLog = execSync('git log --reverse --format="%H|||%s|||%ai|||%an"', {
        cwd: absolutePath,
        encoding: 'utf-8'
    });
    
    commits = gitLog.trim().split('\n').filter(line => line).map(line => {
        const [hash, message, date, author] = line.split('|||');
        return { hash, message, date, author };
    });
} catch (error) {
    // Not a git repository or no commits
}

// Function to read file content for a specific commit
function getFileContent(filePath, commitHash = null) {
    try {
        if (commitHash && isGitRepo) {
            return execSync(`git show ${commitHash}:"${filePath}"`, {
                cwd: absolutePath,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'ignore']
            });
        } else {
            const fullPath = path.join(absolutePath, filePath);
            return readFileSync(fullPath, 'utf-8');
        }
    } catch (error) {
        return null;
    }
}

// Simplified code structure analyzer
function analyzeFileStructure(filePath, commitHash = null) {
    const content = getFileContent(filePath, commitHash);
    if (!content) return null;
    
    const lines = content.split('\n');
    
    const structure = {
        totalLines: lines.length,
        emptyLines: 0,
        commentLines: 0,
        codeLines: 0,
        blocks: [],
        definitions: [],
        includes: [],
        sections: [],
        variables: []
    };
    
    lines.forEach((line, index) => {
        const trimmed = line.trim();
        const lineNum = index + 1;
        
        if (trimmed === '') {
            structure.emptyLines++;
            return;
        }
        
        // Comment detection
        if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith(';') || 
            trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('--')) {
            structure.commentLines++;
            return;
        }
        
        // Import detection
        if (trimmed.startsWith('import ') || trimmed.startsWith('require(') || 
            trimmed.startsWith('from ') || trimmed.includes('require(')) {
            structure.includes.push({
                line: lineNum,
                type: 'import',
                content: trimmed.substring(0, 100)
            });
            structure.codeLines++;
            return;
        }
        
        // Function detection
        const funcMatch = trimmed.match(/(?:function|def|func|fn)\s+(\w+)/);
        if (funcMatch) {
            structure.blocks.push({
                line: lineNum,
                type: 'function',
                name: funcMatch[1],
                content: trimmed.substring(0, 100)
            });
            structure.codeLines++;
            return;
        }
        
        // Class detection
        const classMatch = trimmed.match(/class\s+(\w+)/);
        if (classMatch) {
            structure.definitions.push({
                line: lineNum,
                type: 'class',
                name: classMatch[1],
                content: trimmed.substring(0, 100)
            });
            structure.codeLines++;
            return;
        }
        
        structure.codeLines++;
    });
    
    return structure;
}

// Calculate file detail map data
function calculateFileDetailMapData(filePath, commitHash = null) {
    const structure = analyzeFileStructure(filePath, commitHash);
    if (!structure) return null;
    
    const nodes = [];
    const links = [];
    let id = 0;
    
    const rootId = id++;
    nodes.push({
        id: rootId,
        name: path.basename(filePath),
        type: 'file',
        path: filePath,
        depth: 0,
        size: structure.totalLines,
        childrenCount: 3
    });
    
    // Overview node
    const overviewId = id++;
    nodes.push({
        id: overviewId,
        name: 'Overview',
        type: 'section',
        path: filePath + '#overview',
        depth: 1,
        size: structure.totalLines,
        childrenCount: 4
    });
    links.push({ source: rootId, target: overviewId, depth: 1 });
    
    // Detail nodes
    const details = [
        `Total: ${structure.totalLines} lines`,
        `Code: ${structure.codeLines} lines`,
        `Comments: ${structure.commentLines} lines`,
        `Empty: ${structure.emptyLines} lines`
    ];
    
    details.forEach(name => {
        const detailId = id++;
        nodes.push({ id: detailId, name, type: 'detail', depth: 2, size: 1 });
        links.push({ source: overviewId, target: detailId, depth: 2 });
    });
    
    // Functions section
    if (structure.blocks.length > 0) {
        const blocksId = id++;
        nodes.push({
            id: blocksId,
            name: `Functions (${structure.blocks.length})`,
            type: 'section',
            depth: 1,
            size: structure.blocks.length,
            childrenCount: Math.min(structure.blocks.length, 10)
        });
        links.push({ source: rootId, target: blocksId, depth: 1 });
        
        structure.blocks.slice(0, 10).forEach(block => {
            const blockId = id++;
            nodes.push({
                id: blockId,
                name: block.name,
                type: 'function',
                depth: 2,
                size: 1,
                line: block.line
            });
            links.push({ source: blocksId, target: blockId, depth: 2 });
        });
    }
    
    // Classes section
    if (structure.definitions.length > 0) {
        const defsId = id++;
        nodes.push({
            id: defsId,
            name: `Classes (${structure.definitions.length})`,
            type: 'section',
            depth: 1,
            size: structure.definitions.length,
            childrenCount: Math.min(structure.definitions.length, 10)
        });
        links.push({ source: rootId, target: defsId, depth: 1 });
        
        structure.definitions.slice(0, 10).forEach(def => {
            const defId = id++;
            nodes.push({
                id: defId,
                name: def.name,
                type: 'class',
                depth: 2,
                size: 1,
                line: def.line
            });
            links.push({ source: defsId, target: defId, depth: 2 });
        });
    }
    
    return { nodes, links };
}

// Function to build file tree structure
async function buildFileTree(dirPath, ignoreList = ['.git', 'node_modules', '.DS_Store']) {
    const name = path.basename(dirPath);
    const stats = statSync(dirPath);
    
    const node = {
        name,
        path: dirPath,
        type: stats.isDirectory() ? 'directory' : 'file',
        size: stats.size
    };
    
    if (stats.isDirectory()) {
        const children = [];
        try {
            const files = await fs.readdir(dirPath);
            
            for (const file of files.sort()) {
                if (!ignoreList.includes(file) && !file.startsWith('.')) {
                    const fullPath = path.join(dirPath, file);
                    try {
                        const child = await buildFileTree(fullPath, ignoreList);
                        children.push(child);
                    } catch (err) {
                        // Skip inaccessible files
                    }
                }
            }
        } catch (error) {
            console.error(`Error reading ${dirPath}:`, error.message);
        }
        node.children = children;
    }
    
    return node;
}

// Function to build file tree for specific git commit
function buildGitFileTree(commitHash) {
    try {
        const fileList = execSync(`git ls-tree -r --name-only ${commitHash}`, {
            cwd: absolutePath,
            encoding: 'utf-8'
        });
        
        const files = fileList.trim().split('\n').filter(f => f);
        const tree = { name: path.basename(absolutePath), type: 'directory', children: [] };
        const pathMap = new Map();
        
        files.forEach(filePath => {
            const parts = filePath.split('/');
            let currentLevel = tree.children;
            let currentPath = '';
            
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                currentPath = currentPath ? `${currentPath}/${part}` : part;
                
                if (i === parts.length - 1) {
                    currentLevel.push({
                        name: part,
                        type: 'file',
                        path: filePath
                    });
                } else {
                    let dirNode = pathMap.get(currentPath);
                    if (!dirNode) {
                        dirNode = {
                            name: part,
                            type: 'directory',
                            children: []
                        };
                        currentLevel.push(dirNode);
                        pathMap.set(currentPath, dirNode);
                    }
                    currentLevel = dirNode.children;
                }
            }
        });
        
        const sortTree = (node) => {
            if (node.children) {
                node.children.sort((a, b) => {
                    if (a.type === b.type) return a.name.localeCompare(b.name);
                    return a.type === 'directory' ? -1 : 1;
                });
                node.children.forEach(sortTree);
            }
        };
        sortTree(tree);
        
        return tree;
    } catch (error) {
        console.error(`Error getting git tree for commit ${commitHash}:`, error.message);
        return null;
    }
}

// Calculate map layout data
function calculateMapData(node, depth = 0) {
    const nodes = [];
    const links = [];
    let id = 0;
    
    function processNode(node, parentId = null, depth = 0, path = '') {
        const currentId = id++;
        const currentPath = path ? `${path}/${node.name}` : node.name;
        
        const nodeData = {
            id: currentId,
            name: node.name,
            type: node.type,
            path: currentPath,
            depth,
            size: node.size || 0,
            childrenCount: node.children ? node.children.length : 0
        };
        
        nodes.push(nodeData);
        
        if (parentId !== null) {
            links.push({
                source: parentId,
                target: currentId,
                depth
            });
        }
        
        if (node.children && node.children.length > 0) {
            node.children.forEach(child => {
                processNode(child, currentId, depth + 1, currentPath);
            });
        }
    }
    
    processNode(node);
    
    return { nodes, links };
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Generate HTML
function generateHTML(initialTree, isGitRepo, commits) {
    const mapData = calculateMapData(initialTree);
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>File Tree Visualizer</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; height: 100vh; overflow: hidden; }
        .container { max-width: 100%; height: 100%; display: flex; flex-direction: column; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-shrink: 0; }
        h1 { color: #58a6ff; font-size: 24px; margin: 0; }
        .view-toggle { display: flex; gap: 10px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 4px; }
        .view-btn { background: transparent; color: #8b949e; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px; transition: all 0.2s; }
        .view-btn.active { background: #1f6feb; color: white; }
        .view-btn:hover:not(.active) { background: #21262d; color: #c9d1d9; }
        .git-controls { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 15px; margin-bottom: 20px; flex-shrink: 0; display: ${isGitRepo ? 'block' : 'none'}; }
        .commit-navigation { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
        .btn { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; transition: all 0.2s; }
        .btn:hover { background: #30363d; border-color: #8b949e; }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .commit-slider { flex: 1; -webkit-appearance: none; height: 6px; background: #30363d; border-radius: 3px; outline: none; }
        .commit-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 16px; height: 16px; background: #58a6ff; border-radius: 50%; cursor: pointer; }
        .commit-info { color: #8b949e; font-size: 13px; margin-top: 8px; }
        .commit-info span { color: #58a6ff; font-weight: 600; }
        .main-content { flex: 1; display: flex; gap: 20px; overflow: hidden; min-height: 0; }
        .views-container { flex: 1; overflow: hidden; position: relative; min-width: 0; }
        .file-detail-view { width: 450px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; display: none; flex-direction: column; overflow: hidden; }
        .file-detail-view.active { display: flex; }
        .file-detail-header { padding: 15px; border-bottom: 1px solid #30363d; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
        .file-detail-title { color: #58a6ff; font-size: 16px; font-weight: 600; word-break: break-all; flex: 1; margin-right: 10px; }
        .close-btn { background: none; border: none; color: #8b949e; cursor: pointer; font-size: 20px; padding: 5px; transition: color 0.2s; }
        .close-btn:hover { color: #f85149; }
        .file-detail-content { flex: 1; overflow: hidden; position: relative; min-height: 300px; }
        .file-detail-svg { width: 100%; height: 100%; }
        .tree-view, .map-view { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: #161b22; border: 1px solid #30363d; border-radius: 6px; overflow: auto; }
        .tree-view { padding: 20px; }
        .map-view { padding: 20px; display: none; }
        .map-view.active { display: block; }
        .tree-view.active { display: block; }
        .tree-view.hidden, .map-view.hidden { display: none; }
        .tree { font-family: 'Courier New', monospace; font-size: 14px; line-height: 1.6; }
        .tree-item { margin-left: 20px; }
        .tree-node { display: flex; align-items: center; padding: 2px 0; border-radius: 3px; transition: background 0.2s; }
        .tree-node:hover { background: #1c2128; }
        .tree-node.clickable { cursor: pointer; }
        .tree-node.clickable:hover { background: #1f6feb33; }
        .icon { margin-right: 8px; width: 20px; text-align: center; }
        .folder { color: #58a6ff; }
        .file { color: #8b949e; }
        .file.clickable { color: #79c0ff; cursor: pointer; }
        .file.clickable:hover { text-decoration: underline; }
        .branch-line { color: #30363d; margin-right: 4px; }
        .toggle-btn { background: none; border: none; color: #58a6ff; cursor: pointer; padding: 0 4px; font-size: 12px; width: 20px; text-align: center; }
        .toggle-btn:hover { color: #79c0ff; }
        .loading { display: none; color: #58a6ff; margin-left: 10px; font-style: italic; }
        .stats { color: #8b949e; font-size: 12px; margin-top: 10px; flex-shrink: 0; }
        .map-svg, .file-detail-svg { width: 100%; height: 100%; min-height: 300px; }
        .map-node { cursor: pointer; transition: all 0.3s; }
        .map-node:hover { filter: brightness(1.3); }
        .map-node-circle { stroke-width: 2px; transition: all 0.3s; }
        .map-node:hover .map-node-circle { stroke-width: 3px; }
        .map-link { stroke: #30363d; stroke-width: 1.5px; transition: all 0.3s; }
        .map-link:hover { stroke: #58a6ff; stroke-width: 2px; }
        .map-label { fill: #c9d1d9; font-size: 10px; pointer-events: none; text-anchor: middle; }
        .map-tooltip, .file-detail-tooltip { position: absolute; background: #1c2128; border: 1px solid #30363d; border-radius: 6px; padding: 10px; color: #c9d1d9; font-size: 12px; pointer-events: none; opacity: 0; transition: opacity 0.2s; z-index: 1000; max-width: 300px; }
        .file-detail-tooltip { max-width: 250px; }
        .map-controls, .file-detail-controls { position: absolute; bottom: 20px; right: 20px; display: flex; gap: 5px; z-index: 10; }
        .zoom-btn { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 16px; }
        .zoom-btn:hover { background: #30363d; }
        .file-content-preview { padding: 10px; background: #0d1117; border-top: 1px solid #30363d; max-height: 200px; overflow-y: auto; font-family: 'Courier New', monospace; font-size: 12px; flex-shrink: 0; }
        .file-content-preview pre { margin: 0; white-space: pre-wrap; word-wrap: break-word; }
        .empty-detail-message { display: flex; align-items: center; justify-content: center; height: 100%; color: #8b949e; font-size: 14px; text-align: center; padding: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📁 File Tree Architecture</h1>
            <div class="view-toggle">
                <button class="view-btn active" onclick="switchView('tree')">🌳 Tree View</button>
                <button class="view-btn" onclick="switchView('map')">🗺️ Map View</button>
            </div>
        </div>
        
        <div class="git-controls" id="gitControls">
            <div class="commit-navigation">
                <button class="btn" onclick="navigateCommit(-1)" id="prevBtn">◀ Previous</button>
                <input type="range" class="commit-slider" id="commitSlider" 
                       min="0" max="${Math.max(0, commits.length - 1)}" value="${Math.max(0, commits.length - 1)}"
                       oninput="onSliderChange(this.value)">
                <button class="btn" onclick="navigateCommit(1)" id="nextBtn">Next ▶</button>
                <span class="loading" id="loading">Loading...</span>
            </div>
            <div class="commit-info">
                Commit: <span id="commitMessage">${commits.length > 0 ? escapeHtml(commits[commits.length - 1].message) : 'Current'}</span><br>
                Date: <span id="commitDate">${commits.length > 0 ? commits[commits.length - 1].date : new Date().toISOString()}</span><br>
                Author: <span id="commitAuthor">${commits.length > 0 ? escapeHtml(commits[commits.length - 1].author) : 'N/A'}</span>
            </div>
        </div>
        
        <div class="main-content">
            <div class="views-container">
                <div class="tree-view active" id="treeView">
                    <div class="tree" id="treeContainer">
                        ${renderTreeHTML(initialTree)}
                    </div>
                </div>
                
                <div class="map-view" id="mapView">
                    <svg class="map-svg" id="mapSvg"></svg>
                    <div class="map-tooltip" id="mapTooltip"></div>
                    <div class="map-controls">
                        <button class="zoom-btn" onclick="zoomMap(1.2)">➕</button>
                        <button class="zoom-btn" onclick="zoomMap(0.8)">➖</button>
                        <button class="zoom-btn" onclick="resetMap()">🔄</button>
                    </div>
                </div>
            </div>
            
            <div class="file-detail-view" id="fileDetailView">
                <div class="file-detail-header">
                    <span class="file-detail-title" id="fileDetailTitle">Select a file to view details</span>
                    <button class="close-btn" onclick="closeFileDetail()">✕</button>
                </div>
                <div class="file-detail-content" id="fileDetailContent">
                    <svg class="file-detail-svg" id="fileDetailSvg" style="display:none;"></svg>
                    <div class="empty-detail-message" id="emptyDetailMessage">Click on a file in the tree or map view to see its structure</div>
                    <div class="file-detail-tooltip" id="fileDetailTooltip"></div>
                    <div class="file-detail-controls" id="fileDetailControls" style="display:none;">
                        <button class="zoom-btn" onclick="zoomFileDetailMap(1.2)">➕</button>
                        <button class="zoom-btn" onclick="zoomFileDetailMap(0.8)">➖</button>
                        <button class="zoom-btn" onclick="resetFileDetailMap()">🔄</button>
                    </div>
                </div>
                <div class="file-content-preview" id="fileContentPreview" style="display:none;">
                    <pre id="fileContentCode"></pre>
                </div>
            </div>
        </div>
        
        <div class="stats" id="stats"></div>
    </div>
    
    <script>
        const commits = ${JSON.stringify(commits)};
        let currentCommitIndex = ${commits.length > 0 ? commits.length - 1 : 0};
        let currentView = 'tree';
        let currentMapData = ${JSON.stringify(mapData)};
        let initialTree = ${JSON.stringify(initialTree)};
        let currentFileDetailData = null;
        let mapTransform = { x: 0, y: 0, scale: 1 };
        let fileDetailMapTransform = { x: 0, y: 0, scale: 1 };
        let isDragging = false;
        let dragStart = { x: 0, y: 0 };
        let isFileDetailDragging = false;
        let fileDetailDragStart = { x: 0, y: 0 };
        let currentSelectedFile = null;
        let isGitRepo = ${isGitRepo};
        
        // View switching
        function switchView(view) {
            currentView = view;
            
            document.querySelectorAll('.view-btn').forEach(btn => btn.classList.remove('active'));
            event.target.classList.add('active');
            
            const treeView = document.getElementById('treeView');
            const mapView = document.getElementById('mapView');
            
            if (view === 'tree') {
                treeView.classList.add('active');
                treeView.classList.remove('hidden');
                mapView.classList.remove('active');
                mapView.classList.add('hidden');
            } else {
                mapView.classList.add('active');
                mapView.classList.remove('hidden');
                treeView.classList.remove('active');
                treeView.classList.add('hidden');
                setTimeout(() => renderMap(currentMapData, 'mapSvg', 'mapTooltip', mapTransform, 'map'), 100);
            }
        }
        
        // Map rendering
        function renderMapData(data, svgId, tooltipId, transform, type) {
            const svg = document.getElementById(svgId);
            const container = svg.parentElement;
            const width = container.clientWidth || 400;
            const height = container.clientHeight || 400;
            
            if (!data || !data.nodes || data.nodes.length === 0) {
                svg.style.display = 'none';
                if (type === 'file-detail') {
                    document.getElementById('emptyDetailMessage').style.display = 'flex';
                    document.getElementById('fileDetailControls').style.display = 'none';
                }
                return;
            }
            
            svg.style.display = 'block';
            if (type === 'file-detail') {
                document.getElementById('emptyDetailMessage').style.display = 'none';
                document.getElementById('fileDetailControls').style.display = 'flex';
            }
            
            // Calculate layout
            const maxDepth = Math.max(...data.nodes.map(n => n.depth || 0), 1);
            const nodesByDepth = {};
            data.nodes.forEach(node => {
                if (!nodesByDepth[node.depth]) nodesByDepth[node.depth] = [];
                nodesByDepth[node.depth].push(node);
            });
            
            const positions = {};
            const margin = { top: 50, bottom: 30, left: 30, right: 30 };
            const availableWidth = width - margin.left - margin.right;
            const availableHeight = height - margin.top - margin.bottom;
            
            data.nodes.forEach(node => {
                const depthNodes = nodesByDepth[node.depth] || [];
                const depthIndex = depthNodes.indexOf(node);
                const totalInDepth = depthNodes.length;
                
                const x = margin.left + (availableWidth / (maxDepth + 1)) * ((node.depth || 0) + 0.5);
                const y = margin.top + (availableHeight / Math.max(totalInDepth, 1)) * (depthIndex + 0.5);
                
                positions[node.id] = { x, y };
            });
            
            // Generate SVG
            let svgContent = '';
            
            // Draw links
            data.links.forEach(link => {
                const source = positions[link.source];
                const target = positions[link.target];
                if (source && target) {
                    const midX = (source.x + target.x) / 2;
                    svgContent += \`<path class="map-link" d="M\${source.x},\${source.y} C\${midX},\${source.y} \${midX},\${target.y} \${target.x},\${target.y}"/>\`;
                }
            });
            
            // Draw nodes
            data.nodes.forEach(node => {
                const pos = positions[node.id];
                if (!pos) return;
                
                let radius, color;
                const nodeType = node.type || 'unknown';
                
                switch(nodeType) {
                    case 'directory': radius = 20; color = '#58a6ff'; break;
                    case 'file': radius = 18; color = '#8b949e'; break;
                    case 'section': radius = 16; color = '#3fb950'; break;
                    case 'function': radius = 12; color = '#d2a8ff'; break;
                    case 'class': radius = 14; color = '#f0883e'; break;
                    case 'import': radius = 10; color = '#79c0ff'; break;
                    case 'detail': radius = 8; color = '#8b949e'; break;
                    default: radius = 8; color = '#8b949e';
                }
                
                let displayName = node.name || '';
                if (displayName.length > 20) displayName = displayName.substring(0, 18) + '...';
                
                svgContent += \`<g class="map-node" transform="translate(\${pos.x},\${pos.y})" data-path="\${node.path || ''}" data-type="\${nodeType}">\`;
                svgContent += \`<circle class="map-node-circle" r="\${radius}" fill="\${color}" stroke="\${color}" opacity="0.8"/>\`;
                svgContent += \`<text class="map-label" dy="\${radius + 12}" text-anchor="middle" fill="#c9d1d9">\${displayName}</text>\`;
                svgContent += '</g>';
            });
            
            svg.innerHTML = svgContent;
            
            // Add click handlers
            svg.querySelectorAll('.map-node').forEach(nodeEl => {
                nodeEl.addEventListener('click', function(e) {
                    const path = this.getAttribute('data-path');
                    const type = this.getAttribute('data-type');
                    if (type === 'file' && path) {
                        openFileDetail(path);
                    }
                });
            });
            
            // Add drag and zoom
            if (type === 'map') {
                svg.onmousedown = function(e) {
                    isDragging = true;
                    dragStart = { x: e.clientX - mapTransform.x, y: e.clientY - mapTransform.y };
                    svg.style.cursor = 'grabbing';
                };
                svg.onmousemove = function(e) {
                    if (isDragging) {
                        mapTransform.x = e.clientX - dragStart.x;
                        mapTransform.y = e.clientY - dragStart.y;
                        updateMapTransform();
                    }
                };
                svg.onwheel = function(e) {
                    e.preventDefault();
                    const delta = e.deltaY > 0 ? 0.9 : 1.1;
                    zoomMap(delta, e.clientX, e.clientY);
                };
            } else {
                svg.onmousedown = function(e) {
                    isFileDetailDragging = true;
                    fileDetailDragStart = { x: e.clientX - fileDetailMapTransform.x, y: e.clientY - fileDetailMapTransform.y };
                    svg.style.cursor = 'grabbing';
                };
                svg.onmousemove = function(e) {
                    if (isFileDetailDragging) {
                        fileDetailMapTransform.x = e.clientX - fileDetailDragStart.x;
                        fileDetailMapTransform.y = e.clientY - fileDetailDragStart.y;
                        updateFileDetailMapTransform();
                    }
                };
                svg.onwheel = function(e) {
                    e.preventDefault();
                    const delta = e.deltaY > 0 ? 0.9 : 1.1;
                    zoomFileDetailMap(delta, e.clientX, e.clientY);
                };
            }
            
            svg.onmouseup = function() {
                isDragging = false;
                isFileDetailDragging = false;
                svg.style.cursor = 'grab';
            };
            
            svg.style.cursor = 'grab';
            updateTransform(transform, svgId);
        }
        
        function updateTransform(transform, svgId) {
            const svg = document.getElementById(svgId);
            svg.style.transform = \`translate(\${transform.x}px, \${transform.y}px) scale(\${transform.scale})\`;
        }
        
        function renderMap(data, svgId, tooltipId, transform, type) {
            renderMapData(data, svgId, tooltipId, transform, type);
        }
        
        function updateMapTransform() {
            updateTransform(mapTransform, 'mapSvg');
        }
        
        function zoomMap(factor, cx, cy) {
            mapTransform.scale *= factor;
            if (cx && cy) {
                mapTransform.x = cx - (cx - mapTransform.x) * factor;
                mapTransform.y = cy - (cy - mapTransform.y) * factor;
            }
            updateMapTransform();
        }
        
        function resetMap() {
            mapTransform = { x: 0, y: 0, scale: 1 };
            updateMapTransform();
        }
        
        function updateFileDetailMapTransform() {
            updateTransform(fileDetailMapTransform, 'fileDetailSvg');
        }
        
        function zoomFileDetailMap(factor, cx, cy) {
            fileDetailMapTransform.scale *= factor;
            if (cx && cy) {
                fileDetailMapTransform.x = cx - (cx - fileDetailMapTransform.x) * factor;
                fileDetailMapTransform.y = cy - (cy - fileDetailMapTransform.y) * factor;
            }
            updateFileDetailMapTransform();
        }
        
        function resetFileDetailMap() {
            fileDetailMapTransform = { x: 0, y: 0, scale: 1 };
            updateFileDetailMapTransform();
        }
        
        // File detail functions
        async function openFileDetail(filePath) {
            currentSelectedFile = filePath;
            const fileDetailView = document.getElementById('fileDetailView');
            const fileDetailTitle = document.getElementById('fileDetailTitle');
            const fileDetailSvg = document.getElementById('fileDetailSvg');
            const emptyDetailMessage = document.getElementById('emptyDetailMessage');
            const fileDetailControls = document.getElementById('fileDetailControls');
            
            fileDetailTitle.textContent = '📄 ' + filePath.split('/').pop();
            fileDetailView.classList.add('active');
            
            fileDetailSvg.style.display = 'none';
            emptyDetailMessage.style.display = 'flex';
            emptyDetailMessage.textContent = 'Loading...';
            fileDetailControls.style.display = 'none';
            document.getElementById('fileContentPreview').style.display = 'none';
            
            document.getElementById('loading').style.display = 'inline';
            
            try {
                let commitHash = null;
                if (isGitRepo && commits.length > 0 && currentCommitIndex >= 0) {
                    commitHash = commits[currentCommitIndex].hash;
                }
                
                let url = '/file-detail/' + encodeURIComponent(filePath);
                if (commitHash) url += '?commit=' + commitHash;
                
                const response = await fetch(url);
                
                if (!response.ok) {
                    throw new Error('Failed to fetch file details');
                }
                
                currentFileDetailData = await response.json();
                
                fileDetailMapTransform = { x: 0, y: 0, scale: 1 };
                
                if (currentFileDetailData && currentFileDetailData.nodes && currentFileDetailData.nodes.length > 0) {
                    renderMap(currentFileDetailData, 'fileDetailSvg', 'fileDetailTooltip', fileDetailMapTransform, 'file-detail');
                    
                    // Try to load file content preview
                    try {
                        let contentUrl = '/file-content/' + encodeURIComponent(filePath);
                        if (commitHash) contentUrl += '?commit=' + commitHash;
                        
                        const contentResponse = await fetch(contentUrl);
                        const contentData = await contentResponse.json();
                        
                        if (contentData.content) {
                            const preview = document.getElementById('fileContentPreview');
                            const code = document.getElementById('fileContentCode');
                            preview.style.display = 'block';
                            
                            const truncatedContent = contentData.content.length > 3000 
                                ? contentData.content.substring(0, 3000) + '\\n\\n... (truncated, showing first 3000 characters)'
                                : contentData.content;
                            
                            code.textContent = truncatedContent;
                        }
                    } catch (contentError) {
                        console.error('Error loading file content:', contentError);
                    }
                } else {
                    emptyDetailMessage.style.display = 'flex';
                    emptyDetailMessage.textContent = 'No structure could be analyzed for this file';
                }
            } catch (error) {
                console.error('Error loading file detail:', error);
                emptyDetailMessage.style.display = 'flex';
                emptyDetailMessage.textContent = 'Error loading file details: ' + error.message;
            } finally {
                document.getElementById('loading').style.display = 'none';
            }
        }
        
        function closeFileDetail() {
            const fileDetailView = document.getElementById('fileDetailView');
            fileDetailView.classList.remove('active');
            currentSelectedFile = null;
            currentFileDetailData = null;
            document.getElementById('fileDetailSvg').style.display = 'none';
            document.getElementById('emptyDetailMessage').style.display = 'flex';
            document.getElementById('emptyDetailMessage').textContent = 'Click on a file in the tree or map view to see its structure';
            document.getElementById('fileDetailControls').style.display = 'none';
            document.getElementById('fileContentPreview').style.display = 'none';
        }
        
        // Tree functions
        function toggleFolder(btn) {
            const treeItem = btn.parentElement.nextElementSibling;
            if (treeItem && treeItem.classList.contains('tree-item')) {
                if (treeItem.style.display === 'none') {
                    treeItem.style.display = 'block';
                    btn.textContent = '▼';
                } else {
                    treeItem.style.display = 'none';
                    btn.textContent = '▶';
                }
            }
        }
        
        function renderTreeFromData(node, level, prefix, isLast) {
            if (level === undefined) level = 0;
            if (prefix === undefined) prefix = '';
            if (isLast === undefined) isLast = true;
            
            let html = '';
            
            if (level > 0) {
                html += '<div class="tree-node' + (node.type === 'file' ? ' clickable' : '') + '"';
                if (node.type === 'file') {
                    const filePath = (node.path || node.name).replace(/'/g, "\\'");
                    html += ' onclick="openFileDetail(\\'' + filePath + '\\')"';
                }
                html += '>';
                html += '<span class="branch-line">' + prefix + (isLast ? '└── ' : '├── ') + '</span>';
                
                if (node.type === 'directory') {
                    html += '<span class="toggle-btn" onclick="event.stopPropagation(); toggleFolder(this)">▼</span>';
                    html += '<span class="icon folder">📁</span>';
                    html += '<span class="folder">' + (node.name || '') + '/</span>';
                    html += '</div>';
                    
                    if (node.children && node.children.length > 0) {
                        html += '<div class="tree-item">';
                        const newPrefix = prefix + (isLast ? '    ' : '│   ');
                        for (let i = 0; i < node.children.length; i++) {
                            html += renderTreeFromData(node.children[i], level + 1, newPrefix, i === node.children.length - 1);
                        }
                        html += '</div>';
                    }
                } else {
                    html += '<span class="icon file">📄</span>';
                    html += '<span class="file clickable">' + (node.name || '') + '</span>';
                    html += '</div>';
                }
            } else {
                html += '<div class="tree-node">';
                html += '<span class="icon folder">📁</span>';
                html += '<span class="folder" style="font-weight: bold;">' + (node.name || '') + '/</span>';
                html += '</div>';
                
                if (node.children && node.children.length > 0) {
                    html += '<div class="tree-item">';
                    for (let i = 0; i < node.children.length; i++) {
                        html += renderTreeFromData(node.children[i], 1, '', i === node.children.length - 1);
                    }
                    html += '</div>';
                }
            }
            
            return html;
        }
        
        // Git navigation
        async function onSliderChange(value) {
            currentCommitIndex = parseInt(value);
            await loadCommit(commits[currentCommitIndex].hash);
        }
        
        async function navigateCommit(direction) {
            const newIndex = currentCommitIndex + direction;
            if (newIndex >= 0 && newIndex < commits.length) {
                currentCommitIndex = newIndex;
                document.getElementById('commitSlider').value = currentCommitIndex;
                await loadCommit(commits[currentCommitIndex].hash);
            }
        }
        
        async function loadCommit(hash) {
            document.getElementById('loading').style.display = 'inline';
            document.getElementById('prevBtn').disabled = true;
            document.getElementById('nextBtn').disabled = true;
            
            try {
                const response = await fetch('/tree/' + hash);
                const data = await response.json();
                
                if (currentView === 'tree') {
                    document.getElementById('treeContainer').innerHTML = renderTreeFromData(data.tree);
                }
                
                const mapResponse = await fetch('/map/' + hash);
                currentMapData = await mapResponse.json();
                
                if (currentView === 'map') {
                    renderMap(currentMapData, 'mapSvg', 'mapTooltip', mapTransform, 'map');
                }
                
                if (currentSelectedFile) {
                    await openFileDetail(currentSelectedFile);
                }
                
                document.getElementById('commitMessage').textContent = data.commit.message;
                document.getElementById('commitDate').textContent = data.commit.date;
                document.getElementById('commitAuthor').textContent = data.commit.author;
                
                const stats = countNodes(data.tree);
                document.getElementById('stats').textContent = 'Files: ' + stats.files + ' | Directories: ' + stats.directories;
            } catch (error) {
                console.error('Error loading commit:', error);
            } finally {
                document.getElementById('loading').style.display = 'none';
                document.getElementById('prevBtn').disabled = currentCommitIndex === 0;
                document.getElementById('nextBtn').disabled = currentCommitIndex === commits.length - 1;
            }
        }
        
        function countNodes(node) {
            let files = 0;
            let directories = 0;
            
            if (node.type === 'file') files++;
            else if (node.type === 'directory') directories++;
            
            if (node.children) {
                for (let i = 0; i < node.children.length; i++) {
                    const counts = countNodes(node.children[i]);
                    files += counts.files;
                    directories += counts.directories;
                }
            }
            
            return { files, directories };
        }
        
        // Initialize stats
        const initialStats = countNodes(initialTree);
        document.getElementById('stats').textContent = 'Files: ' + initialStats.files + ' | Directories: ' + initialStats.directories;
        
        // Handle window resize
        window.addEventListener('resize', function() {
            if (currentView === 'map') {
                renderMap(currentMapData, 'mapSvg', 'mapTooltip', mapTransform, 'map');
            }
            if (currentFileDetailData) {
                renderMap(currentFileDetailData, 'fileDetailSvg', 'fileDetailTooltip', fileDetailMapTransform, 'file-detail');
            }
        });
    </script>
</body>
</html>`;
}

function renderTreeHTML(node, level, prefix, isLast) {
    if (level === undefined) level = 0;
    if (prefix === undefined) prefix = '';
    if (isLast === undefined) isLast = true;
    
    let html = '';
    
    if (level > 0) {
        html += '<div class="tree-node' + (node.type === 'file' ? ' clickable' : '') + '"';
        if (node.type === 'file') {
            const filePath = (node.path || node.name).replace(/'/g, "\\'");
            html += ' onclick="openFileDetail(\'' + filePath + '\')"';
        }
        html += '>';
        html += '<span class="branch-line">' + prefix + (isLast ? '└── ' : '├── ') + '</span>';
        
        if (node.type === 'directory') {
            html += '<span class="toggle-btn" onclick="event.stopPropagation(); toggleFolder(this)">▼</span>';
            html += '<span class="icon folder">📁</span>';
            html += '<span class="folder">' + escapeHtml(node.name) + '/</span>';
            html += '</div>';
            
            if (node.children && node.children.length > 0) {
                html += '<div class="tree-item">';
                const newPrefix = prefix + (isLast ? '    ' : '│   ');
                for (let i = 0; i < node.children.length; i++) {
                    html += renderTreeHTML(node.children[i], level + 1, newPrefix, i === node.children.length - 1);
                }
                html += '</div>';
            }
        } else {
            html += '<span class="icon file">📄</span>';
            html += '<span class="file clickable">' + escapeHtml(node.name) + '</span>';
            html += '</div>';
        }
    } else {
        html += '<div class="tree-node">';
        html += '<span class="icon folder">📁</span>';
        html += '<span class="folder" style="font-weight: bold;">' + escapeHtml(node.name) + '/</span>';
        html += '</div>';
        
        if (node.children && node.children.length > 0) {
            html += '<div class="tree-item">';
            for (let i = 0; i < node.children.length; i++) {
                html += renderTreeHTML(node.children[i], 1, '', i === node.children.length - 1);
            }
            html += '</div>';
        }
    }
    
    return html;
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.query;
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    
    try {
        if (pathname === '/') {
            const tree = await buildFileTree(absolutePath);
            const html = generateHTML(tree, isGitRepo, commits);
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
        } else if (pathname.startsWith('/tree/')) {
            const commitHash = pathname.split('/tree/')[1];
            
            if (!isGitRepo) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not a git repository' }));
                return;
            }
            
            const tree = buildGitFileTree(commitHash);
            const commit = commits.find(c => c.hash === commitHash);
            const stats = countNodes(tree);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tree, commit, stats }));
        } else if (pathname.startsWith('/map/')) {
            const commitHash = pathname.split('/map/')[1];
            
            if (!isGitRepo) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not a git repository' }));
                return;
            }
            
            const tree = buildGitFileTree(commitHash);
            const mapData = calculateMapData(tree);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(mapData));
        } else if (pathname.startsWith('/file-detail/')) {
            const filePath = decodeURIComponent(pathname.split('/file-detail/')[1]);
            const commitHash = query.commit || null;
            
            const detailMapData = calculateFileDetailMapData(filePath, commitHash);
            
            if (!detailMapData) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ nodes: [], links: [] }));
                return;
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(detailMapData));
        } else if (pathname.startsWith('/file-content/')) {
            const filePath = decodeURIComponent(pathname.split('/file-content/')[1]);
            const commitHash = query.commit || null;
            
            const content = getFileContent(filePath, commitHash);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                content: content,
                path: filePath,
                commit: commitHash
            }));
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    } catch (error) {
        console.error('Server error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
});

function countNodes(node) {
    let files = 0;
    let directories = 0;
    
    if (node.type === 'file') files++;
    else if (node.type === 'directory') directories++;
    
    if (node.children) {
        node.children.forEach(child => {
            const counts = countNodes(child);
            files += counts.files;
            directories += counts.directories;
        });
    }
    
    return { files, directories };
}

server.listen(PORT, () => {
    console.log(`\n🌳 File Tree Visualizer running at http://localhost:${PORT}`);
    console.log(`📁 Visualizing: ${absolutePath}`);
    
    if (isGitRepo) {
        console.log(`📜 Git repository detected with ${commits.length} commits`);
        console.log(`🔄 Use the slider to navigate through commit history`);
        console.log(`🗺️  Toggle between Tree and Map views`);
        console.log(`📄 Click on files to view detailed structure analysis\n`);
    } else {
        console.log(`ℹ️  Not a git repository - showing current file structure only`);
        console.log(`📄 Click on files to view detailed structure analysis\n`);
    }
});

process.on('SIGINT', () => {
    console.log('\n\n👋 Shutting down server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});