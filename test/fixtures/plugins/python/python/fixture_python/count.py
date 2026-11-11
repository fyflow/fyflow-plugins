class Count:
    def run(self, task, ctx):
        return {"words": len(str(task.input.get("text", "")).split())}
