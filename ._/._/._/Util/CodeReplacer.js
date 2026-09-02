// CodeReplacer.js
import { readFile, writeFile } from 'fs/promises';

export class CodeReplacer {
  // Static buffer for incomplete tag input
  static tagBuffer = '';

  /**
   * Normalize and correct common path errors in AI-generated paths.
   * Specifically fixes patterns like /./ to /._/ when the intent is clearly 
   * to reference a hidden directory with underscore naming.
   * 
   * @param {string} filePath - The raw file path to normalize.
   * @returns {string} The corrected file path.
   */
  static normalizePath(filePath) {
    // Only correct the specific pattern where /./ appears (not .hidden or ../)
    // The regex matches "/./" but not "/../" or "/.hidden/"
    return filePath.replace(/(?<!\.)\/(?=\.\/)/g, '/');
  }

  /**
   * Replace literal strings in a file.
   * @param {string} filePath - Absolute path to the target file.
   * @param {Object|Object[]} replacements - Single object or array of { original, replace }.
   * @returns {Promise<{content: string, changes: Array<{original: string, replace: string, count: number}>}>} 
   *          The new file content and details of all replacements made.
   */
  static async Run(filePath, replacements) {
    // Normalize input to an array
    const list = Array.isArray(replacements) ? replacements : [replacements];

    // Validate each replacement object
    for (const item of list) {
      if (typeof item !== 'object' || item === null ||
          typeof item.original !== 'string' || typeof item.replace !== 'string') {
        throw new Error('Each replacement must be an object with string properties "original" and "replace".');
      }
    }

    // Read file content
    let content = await readFile(filePath, 'utf8');
    const changes = [];

    // Apply all replacements (all occurrences) using split/join for literal matching
    for (const { original, replace } of list) {
      const parts = content.split(original);
      const count = parts.length - 1;
      
      if (count > 0) {
        content = parts.join(replace);
        changes.push({ original, replace, count });
      }
    }

    // Write back to file only if changes were made
    if (changes.length > 0) {
      await writeFile(filePath, content, 'utf8');
    }

    return { content, changes };
  }

  /**
   * Process a (possibly partial) tagged string, accumulate until complete.
   * Can process multiple blocks in a single input.
   * @param {string} input - String chunk containing part of the CODEREPLACER block(s).
   * @returns {Promise<{status: 'waiting'|'finish'|'error', blocks_processed?: number, 
   *                    changes?: Array<{file: string, replacements: Array<{original: string, replace: string, count: number}>}>, 
   *                    error?: string}>}
   */
  static async Tag(input) {
    const START = '[CODEREPLACER-START]';
    const END = '[/CODEREPLACER-END]';

    // Accumulate input
    CodeReplacer.tagBuffer += input;

    // Check if we have at least one complete block
    const startIdx = CodeReplacer.tagBuffer.indexOf(START);
    const endIdx = CodeReplacer.tagBuffer.indexOf(END, startIdx + START.length);

    if (startIdx === -1 || endIdx === -1) {
      // Not enough data yet
      return { status: 'waiting' };
    }

    const allChanges = [];
    let blocksProcessed = 0;

    try {
      // Process all complete blocks in the buffer
      while (true) {
        const currentStart = CodeReplacer.tagBuffer.indexOf(START);
        const currentEnd = CodeReplacer.tagBuffer.indexOf(END, currentStart + START.length);

        if (currentStart === -1 || currentEnd === -1) {
          break; // No more complete blocks
        }

        // Extract the complete block
        const block = CodeReplacer.tagBuffer.slice(currentStart, currentEnd + END.length);
        // Remove the processed block from the buffer
        CodeReplacer.tagBuffer = CodeReplacer.tagBuffer.slice(currentEnd + END.length);

        // Parse the block
        const pathMatch = block.match(/PATH='([^']*)'/);
        if (!pathMatch) {
          throw new Error(`Block ${blocksProcessed + 1}: PATH not found.`);
        }
        
        // Extract and normalize the file path
        const rawFilePath = pathMatch[1];
        const filePath = CodeReplacer.normalizePath(rawFilePath);
        
        // Extract all replacement blocks
        const replacementBlocks = [];
        const replRegex = /\[NEW-REPLACE-START\]([\s\S]*?)\[\/NEW-REPLACE-END\]/g;
        let match;
        while ((match = replRegex.exec(block)) !== null) {
          const inner = match[1];
          const origMatch = inner.match(/\[ORIGINAL-START\]([\s\S]*?)\[\/ORIGINAL-END\]/);
          const replMatch = inner.match(/\[REPLACE-START\]([\s\S]*?)\[\/REPLACE-END\]/);
          if (origMatch && replMatch) {
            replacementBlocks.push({
              original: origMatch[1],
              replace: replMatch[1],
            });
          } else {
            throw new Error(`Block ${blocksProcessed + 1}: Malformed replacement block - missing ORIGINAL or REPLACE section.`);
          }
        }

        if (replacementBlocks.length === 0) {
          throw new Error(`Block ${blocksProcessed + 1}: No replacement blocks found.`);
        }

        // Run the replacements
        const result = await CodeReplacer.Run(filePath, replacementBlocks);
        
        if (result.changes.length > 0) {
          allChanges.push({
            file: filePath,
            replacements: result.changes
          });
        }

        blocksProcessed++;
      }

      return { 
        status: 'finish', 
        blocks_processed: blocksProcessed,
        changes: allChanges 
      };
    } catch (err) {
      return { status: 'error', error: err.message };
    }
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import('fs/promises');
  const fileToRead = process.argv[2] || 'result';
  
  try {
    const content = await fs.readFile(fileToRead, 'utf8');
    const result = await CodeReplacer.Tag(content);
    
    if (result.status === 'finish') {
      console.log('✓ Replacements applied successfully!\n');
      
      if (result.blocks_processed === 0) {
        console.log('No blocks were processed.');
      } else {
        console.log(`Blocks processed: ${result.blocks_processed}`);
        
        if (result.changes.length === 0) {
          console.log('No changes were necessary (all originals already absent).');
        } else {
          console.log('Changes made:\n');
          
          result.changes.forEach((change, idx) => {
            console.log(`${'─'.repeat(50)}`);
            console.log(`File: ${change.file}`);
            console.log(`${'─'.repeat(50)}`);
            
            change.replacements.forEach((repl, replIdx) => {
              console.log(`\n  Replacement ${replIdx + 1}:`);
              console.log(`    Occurrences: ${repl.count}`);
              
              // Truncate long strings for display
              const origPreview = repl.original.length > 40 
                ? repl.original.substring(0, 37) + '...' 
                : repl.original;
              const replPreview = repl.replace.length > 40 
                ? repl.replace.substring(0, 37) + '...' 
                : repl.replace;
              
              console.log(`    Original: "${origPreview}"`);
              console.log(`    Replace:  "${replPreview}"`);
            });
            
            if (idx < result.changes.length - 1) {
              console.log('');
            }
          });
          
          const totalReplacements = result.changes.reduce((sum, change) => 
            sum + change.replacements.reduce((s, repl) => s + repl.count, 0), 0
          );
          
          console.log(`\n${'='.repeat(50)}`);
          console.log(`Total replacements made: ${totalReplacements}`);
        }
      }
    } else if (result.status === 'waiting') {
      console.log('⚠ Input was incomplete. Expected full [CODEREPLACER-START]...[/CODEREPLACER-END] block(s).');
    } else {
      console.error('✗ Error:', result.error);
    }
  } catch (err) {
    console.error('✗ Failed to read file:', err.message);
  }
}