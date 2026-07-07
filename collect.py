import os

with open("output.txt", 'w', encoding='utf-8') as f:
    for root, dirs, files in os.walk("."):
        for file in files:
            file_path = os.path.join(root, file)
            if "git" in file_path:
                continue
            if "collect" in file_path:
                continue
            if "output" in file_path:
                continue
            try:
                with open(file_path, 'r', encoding='utf-8') as input_f:
                    f.write(f"\n=== File: {file_path} ===\n")
                    content = input_f.read()
                    f.write(content)
            except Exception as e:
                pass
            f.write("\n")