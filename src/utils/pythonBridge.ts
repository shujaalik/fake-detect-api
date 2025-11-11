import { spawn } from "child_process";
import path from "path";
import os from "os";
import process from "process";

export async function runPythonPredict(reviews: string[]): Promise<any> {
  const projectRoot = process.cwd(); // current working directory
  const pythonPath =
    os.platform() === "win32"
      ? path.join(projectRoot, "src/components/model/venv", "Scripts", "python.exe")
      : path.join(projectRoot, "src/components/model/venv", "bin", "python");

  return new Promise((resolve, reject) => {
    // Pass the list of reviews as a JSON string to Python
    const py = spawn(pythonPath, ["src/components/model/predict.py", JSON.stringify(reviews)]);
    let data = "";
    let errData = "";

    py.stdout.on("data", chunk => (data += chunk.toString()));
    py.stderr.on("data", chunk => (errData += chunk.toString()));

    py.on("error", err => reject(new Error(`Spawn failed: ${err.message}`)));

    py.on("close", code => {
      if (code !== 0) {
        return reject(new Error(`Python exited with code ${code}: ${errData}`));
      }
      try {
        const parsed = JSON.parse(data);
        resolve(parsed);
      } catch (e) {
        reject(e);
      }
    });
  });
}
