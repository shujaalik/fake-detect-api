import { spawn } from "child_process";
import path from "path";
import process from "process";

export async function runPythonPredict(reviews: string[]): Promise<any> {
  const projectRoot = process.cwd();

  // Absolute path to predict.py
  const scriptPath = path.join(projectRoot, "src", "components", "model", "predict.py");

  return new Promise((resolve, reject) => {
    const py = spawn(
      "python", // uses system Python (Windows PATH)
      [scriptPath, JSON.stringify(reviews)],
      {
        windowsHide: true,
      },
    );

    let data = "";
    let errData = "";

    py.stdout.on("data", chunk => {
      data += chunk.toString();
    });

    py.stderr.on("data", chunk => {
      errData += chunk.toString();
    });

    py.on("error", err => {
      reject(new Error(`Failed to start Python: ${err.message}`));
    });

    py.on("close", code => {
      if (code !== 0) {
        return reject(new Error(`Python exited with code ${code}:\n${errData}`));
      }

      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error(`Invalid JSON from Python:\n${data}`));
      }
    });
  });
}
