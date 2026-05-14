#!/usr/bin/env node

import http from 'http';
import fs from 'fs/promises';
import { existsSync, statSync } from 'fs';
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

// HTML template
const generateHTML = (initialTree, isGitRepo, commits) => {
    const mapData = calculateMapData(initialTree);
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>File Tree Visualizer</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: #0d1117;
            color: #c9d1d9;
            padding: 20px;
            height: 100vh;
            overflow: hidden;
        }
        
        .container {
            max-width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
        }
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            flex-shrink: 0;
        }
        
        h1 {
            color: #58a6ff;
            font-size: 24px;
            margin: 0;
        }
        
        .view-toggle {
            display: flex;
            gap: 10px;
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 6px;
            padding: 4px;
        }
        
        .view-btn {
            background: transparent;
            color: #8b949e;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.2s;
        }
        
        .view-btn.active {
            background: #1f6feb;
            color: white;
        }
        
        .view-btn:hover:not(.active) {
            background: #21262d;
            color: #c9d1d9;
        }
        
        .git-controls {
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 6px;
            padding: 15px;
            margin-bottom: 20px;
            display: ${isGitRepo ? 'block' : 'none'};
            flex-shrink: 0;
        }
        
        .commit-navigation {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 10px;
        }
        
        .btn {
            background: #21262d;
            color: #c9d1d9;
            border: 1px solid #30363d;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.2s;
        }
        
        .btn:hover {
            background: #30363d;
            border-color: #8b949e;
        }
        
        .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .commit-slider {
            flex: 1;
            -webkit-appearance: none;
            height: 6px;
            background: #30363d;
            border-radius: 3px;
            outline: none;
        }
        
        .commit-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 16px;
            height: 16px;
            background: #58a6ff;
            border-radius: 50%;
            cursor: pointer;
        }
        
        .commit-info {
            color: #8b949e;
            font-size: 13px;
            margin-top: 8px;
        }
        
        .commit-info span {
            color: #58a6ff;
            font-weight: 600;
        }
        
        .views-container {
            flex: 1;
            overflow: hidden;
            position: relative;
        }
        
        .tree-view, .map-view {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 6px;
            overflow: auto;
        }
        
        .tree-view {
            padding: 20px;
        }
        
        .map-view {
            padding: 20px;
            display: none;
        }
        
        .map-view.active {
            display: block;
        }
        
        .tree-view.active {
            display: block;
        }
        
        .tree-view.hidden, .map-view.hidden {
            display: none;
        }
        
        .tree {
            font-family: 'Courier New', monospace;
            font-size: 14px;
            line-height: 1.6;
        }
        
        .tree-item {
            margin-left: 20px;
        }
        
        .tree-node {
            display: flex;
            align-items: center;
            padding: 2px 0;
            border-radius: 3px;
            transition: background 0.2s;
        }
        
        .tree-node:hover {
            background: #1c2128;
        }
        
        .icon {
            margin-right: 8px;
            width: 20px;
            text-align: center;
        }
        
        .folder {
            color: #58a6ff;
        }
        
        .file {
            color: #8b949e;
        }
        
        .branch-line {
            color: #30363d;
            margin-right: 4px;
        }
        
        .toggle-btn {
            background: none;
            border: none;
            color: #58a6ff;
            cursor: pointer;
            padding: 0 4px;
            font-size: 12px;
            width: 20px;
            text-align: center;
        }
        
        .toggle-btn:hover {
            color: #79c0ff;
        }
        
        .loading {
            display: none;
            color: #58a6ff;
            margin-left: 10px;
            font-style: italic;
        }
        
        .stats {
            color: #8b949e;
            font-size: 12px;
            margin-top: 10px;
            flex-shrink: 0;
        }
        
        /* Map View Styles */
        .map-svg {
            width: 100%;
            height: 100%;
            min-height: 600px;
        }
        
        .map-node {
            cursor: pointer;
            transition: all 0.3s;
        }
        
        .map-node:hover {
            filter: brightness(1.3);
        }
        
        .map-node-circle {
            stroke-width: 2px;
            transition: all 0.3s;
        }
        
        .map-node:hover .map-node-circle {
            stroke-width: 3px;
        }
        
        .map-link {
            stroke: #30363d;
            stroke-width: 1.5px;
            transition: all 0.3s;
        }
        
        .map-link:hover {
            stroke: #58a6ff;
            stroke-width: 2px;
        }
        
        .map-label {
            fill: #c9d1d9;
            font-size: 11px;
            pointer-events: none;
            text-anchor: middle;
        }
        
        .map-tooltip {
            position: absolute;
            background: #1c2128;
            border: 1px solid #30363d;
            border-radius: 6px;
            padding: 10px;
            color: #c9d1d9;
            font-size: 12px;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.2s;
            z-index: 1000;
            max-width: 300px;
        }
        
        .map-controls {
            position: absolute;
            bottom: 20px;
            right: 20px;
            display: flex;
            gap: 5px;
            z-index: 10;
        }
        
        .zoom-btn {
            background: #21262d;
            color: #c9d1d9;
            border: 1px solid #30363d;
            padding: 5px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 16px;
        }
        
        .zoom-btn:hover {
            background: #30363d;
        }
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
                       min="0" max="${commits.length - 1}" value="${commits.length - 1}"
                       oninput="onSliderChange(this.value)">
                <button class="btn" onclick="navigateCommit(1)" id="nextBtn">Next ▶</button>
                <span class="loading" id="loading">Loading...</span>
            </div>
            <div class="commit-info">
                Commit: <span id="commitMessage">${commits.length > 0 ? commits[commits.length - 1].message : 'Current'}</span><br>
                Date: <span id="commitDate">${commits.length > 0 ? commits[commits.length - 1].date : new Date().toISOString()}</span><br>
                Author: <span id="commitAuthor">${commits.length > 0 ? commits[commits.length - 1].author : 'N/A'}</span>
            </div>
        </div>
        
        <div class="views-container">
            <div class="tree-view active" id="treeView">
                <div class="tree" id="treeContainer">
                    ${renderTree(initialTree)}
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
        
        <div class="stats" id="stats"></div>
    </div>
    
    <script>
        const commits = ${JSON.stringify(commits)};
        let currentCommitIndex = commits.length - 1;
        let currentView = 'tree';
        let currentMapData = ${JSON.stringify(mapData)};
        let mapTransform = { x: 0, y: 0, scale: 1 };
        let isDragging = false;
        let dragStart = { x: 0, y: 0 };
        
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
                setTimeout(() => renderMap(currentMapData), 100);
            }
        }
        
        // Map rendering
        function renderMap(data) {
            const svg = document.getElementById('mapSvg');
            const tooltip = document.getElementById('mapTooltip');
            const width = svg.clientWidth || 800;
            const height = svg.clientHeight || 600;
            
            // Calculate layout
            const maxDepth = Math.max(...data.nodes.map(n => n.depth));
            const nodesByDepth = {};
            data.nodes.forEach(node => {
                if (!nodesByDepth[node.depth]) nodesByDepth[node.depth] = [];
                nodesByDepth[node.depth].push(node);
            });
            
            // Position nodes
            const positions = new Map();
            const margin = { top: 60, bottom: 40, left: 40, right: 40 };
            const availableWidth = width - margin.left - margin.right;
            const availableHeight = height - margin.top - margin.bottom;
            
            data.nodes.forEach((node, index) => {
                const depthNodes = nodesByDepth[node.depth] || [];
                const depthIndex = depthNodes.indexOf(node);
                const totalInDepth = depthNodes.length;
                
                const x = margin.left + (availableWidth / (maxDepth + 1)) * (node.depth + 0.5);
                const y = margin.top + (availableHeight / (totalInDepth + 1)) * (depthIndex + 1);
                
                positions.set(node.id, { x, y });
            });
            
            // Generate SVG
            let svgContent = '';
            
            // Draw links
            data.links.forEach(link => {
                const source = positions.get(link.source);
                const target = positions.get(link.target);
                if (source && target) {
                    const midX = (source.x + target.x) / 2;
                    svgContent += \`
                        <path class="map-link" 
                              d="M\${source.x},\${source.y} C\${midX},\${source.y} \${midX},\${target.y} \${target.x},\${target.y}"
                              data-source="\${link.source}" 
                              data-target="\${link.target}"/>
                    \`;
                }
            });
            
            // Draw nodes
            data.nodes.forEach(node => {
                const pos = positions.get(node.id);
                if (!pos) return;
                
                const radius = node.type === 'directory' ? 
                    Math.min(25, 10 + node.childrenCount * 2) : 8;
                const color = node.type === 'directory' ? '#58a6ff' : '#8b949e';
                const icon = node.type === 'directory' ? '📁' : '📄';
                
                svgContent += \`
                    <g class="map-node" 
                       transform="translate(\${pos.x},\${pos.y})"
                       onmouseenter="showTooltip(event, '\${node.name.replace(/'/g, "\\'")}', '\${node.type}', \${node.childrenCount}, '\${node.path.replace(/'/g, "\\'")}')"
                       onmouseleave="hideTooltip()"
                       onclick="highlightNode('\${node.id}')">
                        <circle class="map-node-circle" 
                                r="\${radius}" 
                                fill="\${color}" 
                                stroke="\${color}"
                                opacity="0.8"/>
                        <text class="map-label" 
                              dy="\${radius + 15}" 
                              text-anchor="middle"
                              fill="#c9d1d9">
                            \${node.name.length > 15 ? node.name.substring(0, 13) + '...' : node.name}
                        </text>
                    </g>
                \`;
            });
            
            svg.innerHTML = svgContent;
            
            // Add pan and zoom
            svg.style.cursor = 'grab';
            svg.onmousedown = (e) => {
                isDragging = true;
                dragStart = { x: e.clientX - mapTransform.x, y: e.clientY - mapTransform.y };
                svg.style.cursor = 'grabbing';
            };
            
            svg.onmousemove = (e) => {
                if (isDragging) {
                    mapTransform.x = e.clientX - dragStart.x;
                    mapTransform.y = e.clientY - dragStart.y;
                    updateMapTransform();
                }
            };
            
            svg.onmouseup = () => {
                isDragging = false;
                svg.style.cursor = 'grab';
            };
            
            svg.onwheel = (e) => {
                e.preventDefault();
                const delta = e.deltaY > 0 ? 0.9 : 1.1;
                zoomMap(delta, e.clientX, e.clientY);
            };
        }
        
        function updateMapTransform() {
            const svg = document.getElementById('mapSvg');
            const group = svg.querySelector('g') || svg;
            svg.style.transform = \`translate(\${mapTransform.x}px, \${mapTransform.y}px) scale(\${mapTransform.scale})\`;
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
        
        function showTooltip(event, name, type, childrenCount, path) {
            const tooltip = document.getElementById('mapTooltip');
            const icon = type === 'directory' ? '📁' : '📄';
            tooltip.innerHTML = \`
                <strong>\${icon} \${name}</strong><br>
                <span style="color: #8b949e;">Type: \${type}</span><br>
                \${type === 'directory' ? '<span style="color: #8b949e;">Children: ' + childrenCount + '</span><br>' : ''}
                <span style="color: #58a6ff; font-size: 11px;">\${path}</span>
            \`;
            tooltip.style.left = (event.clientX + 15) + 'px';
            tooltip.style.top = (event.clientY + 15) + 'px';
            tooltip.style.opacity = '1';
        }
        
        function hideTooltip() {
            document.getElementById('mapTooltip').style.opacity = '0';
        }
        
        function highlightNode(nodeId) {
            // Reset all nodes
            document.querySelectorAll('.map-node').forEach(node => {
                node.style.opacity = '0.3';
            });
            document.querySelectorAll('.map-link').forEach(link => {
                link.style.opacity = '0.1';
            });
            
            // Highlight selected node and its connections
            const selectedNode = document.querySelector(\`[onclick="highlightNode('\${nodeId}')"]\`);
            if (selectedNode) {
                selectedNode.style.opacity = '1';
            }
            
            // Highlight connected links
            currentMapData.links.forEach(link => {
                if (link.source == nodeId || link.target == nodeId) {
                    const linkElement = document.querySelector(\`[data-source="\${link.source}"][data-target="\${link.target}"]\`);
                    if (linkElement) {
                        linkElement.style.opacity = '1';
                        linkElement.style.stroke = '#58a6ff';
                    }
                }
            });
            
            setTimeout(() => {
                document.querySelectorAll('.map-node').forEach(node => {
                    node.style.opacity = '1';
                });
                document.querySelectorAll('.map-link').forEach(link => {
                    link.style.opacity = '1';
                    link.style.stroke = '#30363d';
                });
            }, 2000);
        }
        
        // Tree view functions
        function renderTree(node, level = 0, prefix = '', isLast = true) {
            let html = '';
            
            if (level > 0) {
                html += '<div class="tree-node">';
                html += '<span class="branch-line">' + prefix + (isLast ? '└── ' : '├── ') + '</span>';
                
                if (node.type === 'directory') {
                    html += '<span class="toggle-btn" onclick="toggleFolder(this)">▼</span>';
                    html += '<span class="icon folder">📁</span>';
                    html += '<span class="folder">' + node.name + '/</span>';
                    html += '</div>';
                    
                    if (node.children && node.children.length > 0) {
                        html += '<div class="tree-item">';
                        const newPrefix = prefix + (isLast ? '    ' : '│   ');
                        node.children.forEach((child, index) => {
                            html += renderTree(child, level + 1, newPrefix, index === node.children.length - 1);
                        });
                        html += '</div>';
                    }
                } else {
                    html += '<span class="icon file">📄</span>';
                    html += '<span class="file">' + node.name + '</span>';
                    html += '</div>';
                }
            } else {
                html += '<div class="tree-node">';
                html += '<span class="icon folder">📁</span>';
                html += '<span class="folder" style="font-weight: bold;">' + node.name + '/</span>';
                html += '</div>';
                
                if (node.children && node.children.length > 0) {
                    html += '<div class="tree-item">';
                    node.children.forEach((child, index) => {
                        html += renderTree(child, 1, '', index === node.children.length - 1);
                    });
                    html += '</div>';
                }
            }
            
            return html;
        }
        
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
                    document.getElementById('treeContainer').innerHTML = renderTree(data.tree);
                }
                
                // Update map data
                const mapResponse = await fetch('/map/' + hash);
                currentMapData = await mapResponse.json();
                
                if (currentView === 'map') {
                    renderMap(currentMapData);
                }
                
                document.getElementById('commitMessage').textContent = data.commit.message;
                document.getElementById('commitDate').textContent = data.commit.date;
                document.getElementById('commitAuthor').textContent = data.commit.author;
                document.getElementById('stats').textContent = 
                    'Files: ' + data.stats.files + ' | Directories: ' + data.stats.directories;
            } catch (error) {
                console.error('Error loading commit:', error);
            } finally {
                document.getElementById('loading').style.display = 'none';
                document.getElementById('prevBtn').disabled = currentCommitIndex === 0;
                document.getElementById('nextBtn').disabled = currentCommitIndex === commits.length - 1;
            }
        }
        
        // Count nodes for stats
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
        
        // Initial stats
        const initialStats = countNodes(${JSON.stringify(initialTree)});
        document.getElementById('stats').textContent = 
            'Files: ' + initialStats.files + ' | Directories: ' + initialStats.directories;
        
        // Initialize map on load if needed
        window.addEventListener('resize', () => {
            if (currentView === 'map') {
                renderMap(currentMapData);
            }
        });
    </script>
</body>
</html>`;
};

function renderTree(node, level = 0, prefix = '', isLast = true) {
    let html = '';
    
    if (level > 0) {
        html += '<div class="tree-node">';
        html += '<span class="branch-line">' + prefix + (isLast ? '└── ' : '├── ') + '</span>';
        
        if (node.type === 'directory') {
            html += '<span class="toggle-btn" onclick="toggleFolder(this)">▼</span>';
            html += '<span class="icon folder">📁</span>';
            html += '<span class="folder">' + node.name + '/</span>';
            html += '</div>';
            
            if (node.children && node.children.length > 0) {
                html += '<div class="tree-item">';
                const newPrefix = prefix + (isLast ? '    ' : '│   ');
                node.children.forEach((child, index) => {
                    html += renderTree(child, level + 1, newPrefix, index === node.children.length - 1);
                });
                html += '</div>';
            }
        } else {
            html += '<span class="icon file">📄</span>';
            html += '<span class="file">' + node.name + '</span>';
            html += '</div>';
        }
    } else {
        html += '<div class="tree-node">';
        html += '<span class="icon folder">📁</span>';
        html += '<span class="folder" style="font-weight: bold;">' + node.name + '/</span>';
        html += '</div>';
        
        if (node.children && node.children.length > 0) {
            html += '<div class="tree-item">';
            node.children.forEach((child, index) => {
                html += renderTree(child, 1, '', index === node.children.length - 1);
            });
            html += '</div>';
        }
    }
    
    return html;
}

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

// Create HTTP server
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    
    if (pathname === '/') {
        try {
            const tree = await buildFileTree(absolutePath);
            const html = generateHTML(tree, isGitRepo, commits);
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error: ' + error.message);
        }
    } else if (pathname.startsWith('/tree/')) {
        const commitHash = pathname.split('/tree/')[1];
        
        if (!isGitRepo) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not a git repository' }));
            return;
        }
        
        try {
            const tree = buildGitFileTree(commitHash);
            const commit = commits.find(c => c.hash === commitHash);
            const stats = countNodes(tree);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tree, commit, stats }));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    } else if (pathname.startsWith('/map/')) {
        const commitHash = pathname.split('/map/')[1];
        
        if (!isGitRepo) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not a git repository' }));
            return;
        }
        
        try {
            const tree = buildGitFileTree(commitHash);
            const mapData = calculateMapData(tree);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(mapData));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`\n🌳 File Tree Visualizer running at http://localhost:${PORT}`);
    console.log(`📁 Visualizing: ${absolutePath}`);
    
    if (isGitRepo) {
        console.log(`📜 Git repository detected with ${commits.length} commits`);
        console.log(`🔄 Use the slider to navigate through commit history`);
        console.log(`🗺️  Toggle between Tree and Map views\n`);
    } else {
        console.log(`ℹ️  Not a git repository - showing current file structure only\n`);
    }
});

process.on('SIGINT', () => {
    console.log('\n\n👋 Shutting down server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});