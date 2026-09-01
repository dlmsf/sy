// CodeReplacer.js
import { readFile, writeFile } from 'fs/promises';

export class CodeReplacer {
  // Static buffer for incomplete tag input
  static tagBuffer = '';

  /**
   * Replace literal strings in a file.
   * @param {string} filePath - Absolute path to the target file.
   * @param {Object|Object[]} replacements - Single object or array of { original, replace }.
   * @returns {Promise<string>} The new file content after all replacements.
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

    // Apply all replacements (all occurrences) using split/join for literal matching
    for (const { original, replace } of list) {
      content = content.split(original).join(replace);
    }

    // Write back to file
    await writeFile(filePath, content, 'utf8');

    return content;
  }

  /**
   * Process a (possibly partial) tagged string, accumulate until complete.
   * @param {string} input - String chunk containing part of the CODEREPLACER block.
   * @returns {Promise<{status: 'waiting'|'finish'|'error', new_content?: string, error?: string}>}
   */
  static async Tag(input) {
    const START = '[CODEREPLACER-START]';
    const END = '[/CODEREPLACER-END]';

    // Accumulate input
    CodeReplacer.tagBuffer += input;

    // Check if we have a complete block
    const startIdx = CodeReplacer.tagBuffer.indexOf(START);
    const endIdx = CodeReplacer.tagBuffer.indexOf(END, startIdx + START.length);

    if (startIdx === -1 || endIdx === -1) {
      // Not enough data yet
      return { status: 'waiting' };
    }

    // Extract the complete block (including start and end tags)
    const block = CodeReplacer.tagBuffer.slice(startIdx, endIdx + END.length);
    // Remove the processed block from the buffer, keep any remaining content
    CodeReplacer.tagBuffer = CodeReplacer.tagBuffer.slice(endIdx + END.length);

    try {
      // Parse the block
      const pathMatch = block.match(/PATH='([^']*)'/);
      if (!pathMatch) {
        throw new Error('PATH not found in block.');
      }
      const filePath = pathMatch[1];

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
          throw new Error('Malformed replacement block: missing ORIGINAL or REPLACE section.');
        }
      }

      // Run the replacements
      const newContent = await CodeReplacer.Run(filePath, replacementBlocks);

      return { status: 'finish', new_content: newContent };
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
      console.log('Replacements applied successfully.');
      console.log('New content:');
      console.log(result.new_content);
    } else if (result.status === 'waiting') {
      console.log('Input was incomplete. Expected full [CODEREPLACER-START]...[/CODEREPLACER-END] block.');
    } else {
      console.error('Error:', result.error);
    }
  } catch (err) {
    console.error('Failed to read file:', err.message);
  }
}
