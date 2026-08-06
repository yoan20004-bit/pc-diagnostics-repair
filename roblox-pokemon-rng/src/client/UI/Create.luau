--!nonstrict
--[[
	Create
	A one-function instance builder, so UI code reads as a tree instead of a
	hundred lines of `local x = Instance.new(...)` followed by `x.Parent = y`.

		Create("Frame", {
			Size = UDim2.fromScale(1, 1),
			BackgroundColor3 = ...,
			Create("TextLabel", { Text = "hi" }),
		})

	Array entries are children. Named entries are properties, except `Parent`,
	which is applied last so a tree is fully assembled before it is added to the
	DataModel (one reflow instead of one per child).
]]

local function Create(className: string, props: { [any]: any }?)
	local instance = Instance.new(className)
	local properties = props or {}

	for key, value in properties do
		if type(key) == "number" then
			-- Child, or a plain function used as a "do this to me" hook.
			if type(value) == "function" then
				value(instance)
			else
				value.Parent = instance
			end
		elseif key ~= "Parent" then
			instance[key] = value
		end
	end

	if properties.Parent then
		instance.Parent = properties.Parent
	end

	return instance
end

return Create
